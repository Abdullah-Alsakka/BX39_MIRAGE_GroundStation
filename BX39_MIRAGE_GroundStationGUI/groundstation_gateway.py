#!/usr/bin/env python3
"""Local MIRAGE ground-station gateway.

The flight code sends a packed MainSystemStatusPacket over a TCP connection to
the ground laptop. Browsers cannot receive that raw TCP stream directly, so this
gateway bridges the existing payload protocol to the static GUI:

- TCP :5001 receives payload status packets and sends text commands back.
- HTTP :8080 serves the GUI.
- GET /api/telemetry streams decoded status frames as server-sent events.
- POST /api/command sends a command string to the connected payload socket.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import queue
import socketserver
import struct
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


SENSOR_STRUCT_FORMAT = (
    "<3B"        # seconds, minutes, hours
    "17f"       # Tp1 through Tt3
    "ididid"    # K96 signals & filtered doubles (int32, double, int32, double, int32, double)
    "8f"        # K96 temperatures & humidity floats
    "HHffH"     # MPL block: uflt_ir, flt_ir, uflt_conc, flt_conc, uflt_error
    "HHfHH"     # LPL block: uflt_ir, flt_ir, uflt_conc, uflt_error, flt_error
    "HHfHH"     # SPL block: uflt_ir, flt_ir, uflt_conc, uflt_error, flt_error
    "H"         # K96_error (uint16_t)
    "5BH3B"     # Packet flags & thermal status (operating_mode, command_received, connection_lost, status_ok, pressure_system_on, heater_mask(H), thermal_online, thermal_state, thermal_error)
)

STATUS_PACKET_SIZE = struct.calcsize(SENSOR_STRUCT_FORMAT)

MODE_NAMES = {
    1: "TEST_LOOP",
    2: "STANDBY",
    3: "MEASUREMENTS",
    4: "HUMIDITY",
}


def recv_exact(sock, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size

    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            raise ConnectionError("MCU closed TCP connection")
        chunks.append(chunk)
        remaining -= len(chunk)

    return b"".join(chunks)


def finite_number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback

    if math.isnan(number) or math.isinf(number):
        return fallback
    return number


def pressure_to_hpa(value: float) -> float:
    pressure = finite_number(value, 1013.0)
    if pressure < 20:
        return pressure * 1000.0
    return pressure


def evaluate_health(frame: dict[str, Any]) -> str:
    if frame.get("connectionLost") or not frame.get("statusOk", True):
        return "fault"
    if frame.get("thermalError", 0):
        return "warning"

    chamber_pressure = finite_number(frame.get("chamberPressureBar"), 3.0)
    chamber_temp = finite_number(frame.get("chamberTempC"), 21.0)
    humidity = finite_number(frame.get("humidityRh"), 38.0)

    if (
        chamber_pressure > 3.55
        or chamber_pressure < 2.35
        or chamber_temp > 50
        or chamber_temp < 5
        or humidity > 84
    ):
        return "fault"

    if (
        chamber_pressure > 3.22
        or chamber_pressure < 2.74
        or chamber_temp > 40
        or chamber_temp < 15
        or humidity > 65
    ):
        return "warning"

    return "healthy"


def parse_status_packet(data: bytes, seq: int = 0, timestamp_ms: int | None = None) -> dict[str, Any]:
    if len(data) != STATUS_PACKET_SIZE:
        raise ValueError(f"expected {STATUS_PACKET_SIZE} bytes, got {len(data)}")

    values = struct.unpack(SENSOR_STRUCT_FORMAT, data)
    (
        seconds,
        minutes,
        hours,
        tp1,
        tp2,
        tp3,
        tp6,
        pp3,
        tp4,
        pp1,
        pa1,
        ta1,
        ta2,
        ta3,
        ha1,
        tp5,
        pp2,
        tt1,
        tt2,
        tt3,
        k96_lpl_signal,
        k96_lpl_signal_filtered,
        k96_spl_signal,
        k96_spl_signal_filtered,
        k96_mpl_signal,
        k96_mpl_signal_filtered,
        k96_aducdie_temp,
        k96_aducdie_temp_filtered,
        k96_ntc0_temp,
        k96_ntc0_temp_filtered,
        k96_ntc1_temp,
        k96_ntc1_temp_filtered,
        k96_rh,
        k96_rh_temp,
        k96_mpl_uflt_ir_signal,
        k96_mpl_flt_ir_signal,
        k96_mpl_uflt_conc,
        k96_mpl_flt_conc,
        k96_mpl_uflt_error,
        k96_lpl_uflt_ir_signal,
        k96_lpl_flt_ir_signal,
        k96_lpl_uflt_conc,
        k96_lpl_uflt_error,
        k96_lpl_flt_error,
        k96_spl_uflt_ir_signal,
        k96_spl_flt_ir_signal,
        k96_spl_uflt_conc,
        k96_spl_uflt_error,
        k96_spl_flt_error,
        k96_error,
        operating_mode,
        command_received,
        connection_lost,
        status_ok,
        pressure_system_on,
        heater_mask,
        thermal_online,
        thermal_state,
        thermal_error,
    ) = values

    timestamp = timestamp_ms if timestamp_ms is not None else int(time.time() * 1000)
    link_status = "DROPOUT" if connection_lost else "ONLINE"
    link_quality = 0 if connection_lost else 100

    frame = {
        "valid": not bool(connection_lost),
        "timestamp": timestamp,
        "seq": seq,
        "mode": MODE_NAMES.get(operating_mode, f"MODE_{operating_mode}"),
        "linkStatus": link_status,
        "linkQuality": link_quality,
        "latencyMs": 0,
        "methanePpm": finite_number(k96_lpl_uflt_conc),
        "co2Ppm": finite_number(k96_spl_uflt_conc),
        "waterPpm": finite_number(k96_mpl_uflt_conc),
        "chamberPressureBar": finite_number(pp2),
        "chamberTempC_MS": finite_number(tp5),
        "chamberTempC_K96": finite_number(k96_rh_temp, 0.0),
        "electronicsTempC": finite_number(tt2, 25.0),
        "humidityRh_ambient": finite_number(ha1),
        "humidityRh_k96": finite_number(k96_rh),
        "ambientPressureBar": finite_number(pa1),
        "Interstage_1Bar": finite_number(pp3) + finite_number(pa1),
        "Interstage_2Bar": finite_number(pp1) + finite_number(pa1),
        "pump1C": finite_number(tp1),
        "pump2C": finite_number(tp2),
        "compressorC": finite_number(tp3),
        "Interstage1_C": finite_number(tp6),
        "Interstage2_C": finite_number(tp4),
        "outletC": finite_number(tt1),
        "sdCardC": finite_number(tt2),
        "inletC": finite_number(tt3),
        "ambientTempC_TMP": finite_number(ta1),
        "ambientTempC_MS": finite_number(ta3),
        "ambientTempC_SHT": finite_number(ta2),
        "pumpDutyPct": 100 if pressure_system_on else 0,
        "pump1DutyPct": 100 if pressure_system_on else 0,
        "pump2DutyPct": 100 if pressure_system_on else 0,
        "compressorDutyPct": 100 if pressure_system_on else 0,
        "heaterDutyPct": 100 if heater_mask else 0,
        "coolerDutyPct": 0,
        "outletValveOpen": False,
        "pressureSystemOn": bool(pressure_system_on),
        "heaterMask": int(heater_mask),
        "peripherals": {
            "pump1": bool(pressure_system_on),
            "pump2": bool(pressure_system_on),
            "compressor": bool(pressure_system_on),
            "outletValve": False,
        },
        "relayLines": {
            "relay1": False,
            "relay2": False,
            "relay3": False,
            "relay4": False,
        },
        "onboardLogging": True,
        "storageFreePct": 100,
        "controller": "MAIN_MCU_READY",
        "thermalOnline": bool(thermal_online),
        "thermalState": int(thermal_state),
        "thermalError": int(thermal_error),
        "commandReceived": bool(command_received),
        "connectionLost": bool(connection_lost),
        "statusOk": bool(status_ok),
        "payloadClock": f"{hours:02}:{minutes:02}:{seconds:02}",
        "rawPressures": {
            "k96Hpa": finite_number(k96_ntc0_temp),
        },
        "k96Error": int(k96_error),
    }

    frame["missionMode"] = frame["mode"]
    frame["health"] = evaluate_health(frame)
    if frame["connectionLost"]:
        frame["dropoutReason"] = "payload reported connection_lost in status packet"
        frame["statusText"] = frame["dropoutReason"]
    else:
        frame["statusText"] = "payload status packet decoded from TCP stream"

    return frame


class GroundStationState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._clients: list[queue.Queue[dict[str, Any]]] = []
        self._payload_conn = None
        self._payload_addr = None
        self._seq = 0
        self._last_frame: dict[str, Any] | None = None

    def attach_payload(self, conn, addr) -> None:
        with self._lock:
            self._payload_conn = conn
            self._payload_addr = addr
        self.broadcast_gateway_status()

    def detach_payload(self, conn) -> None:
        with self._lock:
            if self._payload_conn is conn:
                self._payload_conn = None
                self._payload_addr = None
        self.broadcast_gateway_status()

    def add_client(self) -> queue.Queue[dict[str, Any]]:
        client_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=100)
        with self._lock:
            self._clients.append(client_queue)
            last_frame = self._last_frame

        if last_frame:
            client_queue.put({"event": "telemetry", "data": last_frame})
        client_queue.put({"event": "gateway", "data": self.gateway_status()})
        return client_queue

    def remove_client(self, client_queue: queue.Queue[dict[str, Any]]) -> None:
        with self._lock:
            if client_queue in self._clients:
                self._clients.remove(client_queue)

    def next_frame(self, packet: bytes) -> dict[str, Any]:
        with self._lock:
            self._seq += 1
            seq = self._seq

        frame = parse_status_packet(packet, seq=seq)
        with self._lock:
            self._last_frame = frame
        self.broadcast("telemetry", frame)
        return frame

    def send_command(self, command: str) -> tuple[bool, str]:
        payload = command.strip()
        if not payload:
            return False, "empty command"

        with self._lock:
            conn = self._payload_conn

        if conn is None:
            return False, "no payload TCP connection is active"

        try:
            conn.sendall(payload.encode("utf-8"))
        except OSError as exc:
            return False, f"payload command send failed: {exc}"

        return True, f"sent '{payload}' to payload TCP connection"

    def gateway_status(self) -> dict[str, Any]:
        with self._lock:
            payload_connected = self._payload_conn is not None
            payload_addr = self._payload_addr
            client_count = len(self._clients)
            last_frame = self._last_frame

        return {
            "payloadConnected": payload_connected,
            "payloadAddress": f"{payload_addr[0]}:{payload_addr[1]}" if payload_addr else None,
            "browserClients": client_count,
            "lastSeq": last_frame["seq"] if last_frame else None,
            "packetSize": STATUS_PACKET_SIZE,
        }

    def broadcast_gateway_status(self) -> None:
        self.broadcast("gateway", self.gateway_status())

    def broadcast(self, event: str, data: dict[str, Any]) -> None:
        with self._lock:
            clients = list(self._clients)

        message = {"event": event, "data": data}
        for client_queue in clients:
            try:
                client_queue.put_nowait(message)
            except queue.Full:
                pass


class PayloadTCPHandler(socketserver.BaseRequestHandler):
    state: GroundStationState

    def setup(self) -> None:
        self.state.attach_payload(self.request, self.client_address)

    def handle(self) -> None:
        while True:
            packet = recv_exact(self.request, STATUS_PACKET_SIZE)
            if not packet:
                break
            self.state.next_frame(packet)

    def finish(self) -> None:
        self.state.detach_payload(self.request)


class ReusableThreadingTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def make_http_handler(static_root: Path, state: GroundStationState):
    class GroundStationHTTPHandler(SimpleHTTPRequestHandler):
        server_version = "MIRAGEGroundStation/1.0"

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(static_root), **kwargs)

        def end_headers(self) -> None:
            # Prevent browser caching for all served static assets
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            super().end_headers()

        def do_GET(self) -> None:
            if self.path == "/api/status":
                self.send_json(HTTPStatus.OK, state.gateway_status())
                return

            if self.path == "/api/telemetry":
                self.stream_telemetry()
                return

            if self.path == "/":
                self.path = "/index.html"

            super().do_GET()

        def do_POST(self) -> None:
            if self.path != "/api/command":
                self.send_error(HTTPStatus.NOT_FOUND)
                return

            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)

            try:
                payload = json.loads(body.decode("utf-8"))
            except json.JSONDecodeError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "invalid JSON body"})
                return

            command = str(payload.get("wireCommand", "")).strip()
            ok, message = state.send_command(command)
            status = HTTPStatus.OK if ok else HTTPStatus.SERVICE_UNAVAILABLE
            self.send_json(status, {"ok": ok, "message": message})

        def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(encoded)

        def stream_telemetry(self) -> None:
            client_queue = state.add_client()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            try:
                while True:
                    try:
                        message = client_queue.get(timeout=15)
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        continue

                    event_name = message["event"]
                    event_payload = json.dumps(message["data"], allow_nan=False)
                    self.wfile.write(f"event: {event_name}\n".encode("utf-8"))
                    self.wfile.write(f"data: {event_payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                state.remove_client(client_queue)

        def log_message(self, fmt: str, *args) -> None:
            print(f"[http] {self.address_string()} - {fmt % args}")

    return GroundStationHTTPHandler


def run_servers(host: str, http_port: int, payload_port: int, static_root: Path) -> None:
    state = GroundStationState()

    PayloadTCPHandler.state = state
    payload_server = ReusableThreadingTCPServer((host, payload_port), PayloadTCPHandler)

    http_handler = make_http_handler(static_root, state)
    http_server = ReusableThreadingHTTPServer((host, http_port), http_handler)

    payload_thread = threading.Thread(target=payload_server.serve_forever, name="payload-tcp", daemon=True)
    payload_thread.start()

    print(f"MIRAGE GUI: http://127.0.0.1:{http_port}")
    print(f"Payload TCP listener: {host}:{payload_port} expecting {STATUS_PACKET_SIZE} byte status packets")

    try:
        http_server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down MIRAGE ground-station gateway")
    finally:
        http_server.shutdown()
        payload_server.shutdown()
        http_server.server_close()
        payload_server.server_close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the MIRAGE local ground-station gateway")
    parser.add_argument("--host", default="0.0.0.0", help="host/IP for HTTP and payload TCP listeners")
    parser.add_argument("--http-port", default=int(os.environ.get("MIRAGE_HTTP_PORT", "8080")), type=int)
    parser.add_argument("--payload-port", default=int(os.environ.get("MIRAGE_PAYLOAD_PORT", "5001")), type=int)
    parser.add_argument("--static-root", default=Path(__file__).resolve().parent, type=Path)
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    run_servers(args.host, args.http_port, args.payload_port, args.static_root.resolve())
