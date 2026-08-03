import importlib.util
import struct
import unittest
from pathlib import Path


GUI_ROOT = Path(__file__).resolve().parents[1]
GATEWAY_PATH = GUI_ROOT / "groundstation_gateway.py"

spec = importlib.util.spec_from_file_location("groundstation_gateway", GATEWAY_PATH)
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


def make_status_packet(
    *,
    mode=3,
    connection_lost=0,
    status_ok=1,
    pressure_system_on=1,
    heater_mask=0x0D,
    thermal_online=1,
    thermal_error=0,
    captured_errors=0,
):
    floats = [
        31.0,   # Tp1
        32.0,   # Tp2
        33.0,   # Tp3
        24.0,   # Tp6
        0.8,    # Pp3
        25.0,   # Tp4
        1.1,    # Pp1
        0.9,    # Pa1, bar
        -12.0,  # Ta1
        -11.5,  # Ta2
        -12.2,  # Ta3
        41.0,   # Ha1
        21.5,   # Tp5
        3.0,    # Pp2
        18.0,   # Tt1
        27.0,   # Tt2
        19.0,   # Tt3
        416,    # K96_CO2
        1.86,   # K96_CH4
        3100,   # K96_H2O
        3000.0, # K96 pressure hPa
        21,     # K96 temp
        39.0,   # K96 humidity
        *([0.0] * 8),  # K96 temperature/humidity channels not used by this test
        0, 0, 3100.0, 3100.0, 0,  # MPL
        0, 0, 1.86, 0, 0,          # LPL
        0, 0, 416.0, 0, 0,         # SPL
        0,              # K96_error
    ]
    return struct.pack(
        gateway.SENSOR_STRUCT_FORMAT,
        1,
        2,
        3,
        *floats,
        mode,
        0,
        connection_lost,
        status_ok,
        pressure_system_on,
        heater_mask,
        thermal_online,
        2,
        thermal_error,
        2,              # pressure state
        0,              # pressure error
        0x0B,           # relay mask
        180,            # pump 1 PWM
        0,              # pump 2 PWM
        120,            # compressor PWM
            1,              # manual relay override
            1,              # valve open
        captured_errors,
    )


class StatusPacketParserTest(unittest.TestCase):
    def test_error_manifest_is_shared_and_contiguous(self):
        self.assertEqual(len(gateway.ERROR_MESSAGES), 57)
        self.assertEqual(gateway.ERROR_MESSAGES[0], "Ethernet SPI read transaction failed")
        self.assertEqual(gateway.ERROR_MESSAGES[56], "Sensor data file open failed")
        self.assertTrue(gateway.ERROR_MANIFEST_PATH.exists())

    def test_decodes_main_system_status_packet(self):
        frame = gateway.parse_status_packet(make_status_packet(), seq=42, timestamp_ms=123456)

        self.assertTrue(frame["valid"])
        self.assertEqual(frame["seq"], 42)
        self.assertEqual(frame["timestamp"], 123456)
        self.assertEqual(frame["mode"], "MEASUREMENTS")
        self.assertEqual(frame["health"], "healthy")
        self.assertEqual(frame["linkStatus"], "ONLINE")
        self.assertAlmostEqual(frame["methanePpm"], 1.86, places=2)
        self.assertAlmostEqual(frame["chamberPressureBar"], 3.0, places=2)
        self.assertAlmostEqual(frame["ambientPressureHpa"], 900.0, places=1)
        self.assertTrue(frame["pressureSystemOn"])
        self.assertTrue(frame["peripherals"]["pump1"])
        self.assertEqual(frame["pump1DutyPct"], 180)
        self.assertTrue(frame["relayLines"]["relay1"])
        self.assertTrue(frame["relayLines"]["relay4"])
        self.assertTrue(frame["peripherals"]["outletValve"])
        self.assertTrue(frame["pressureValveOpen"])
        self.assertEqual(frame["heaterMask"], 0x0D)
        self.assertTrue(frame["thermalOnline"])
        self.assertEqual(frame["errors"], [])

    def test_decodes_captured_error_bits(self):
        frame = gateway.parse_status_packet(
            make_status_packet(captured_errors=(1 << 0) | (1 << 55)),
        )

        self.assertEqual(frame["health"], "fault")
        self.assertEqual([error["bit"] for error in frame["errors"]], [0, 55])
        self.assertIn("Ethernet SPI read", frame["errors"][0]["message"])

    def test_connection_lost_packet_becomes_dropout(self):
        frame = gateway.parse_status_packet(make_status_packet(connection_lost=1), seq=7)

        self.assertFalse(frame["valid"])
        self.assertEqual(frame["linkStatus"], "DROPOUT")
        self.assertEqual(frame["linkQuality"], 0)
        self.assertIn("connection_lost", frame["dropoutReason"])

    def test_bad_packet_size_is_rejected(self):
        with self.assertRaises(ValueError):
            gateway.parse_status_packet(b"short")


class FrontendCommandContractTest(unittest.TestCase):
    def test_frontend_contains_hardware_command_strings(self):
        app_js = (GUI_ROOT / "src" / "app.js").read_text(encoding="utf-8")

        expected_wire_commands = [
            "RELAY 1 ON",
            "RELAY 4 OFF",
            "PUMP 1 ON",
            "PUMP 2 OFF",
            "COMPRESSOR ON",
            "VALVE OPEN",
            "HEATER ALL ON",
            "MODE MEASUREMENTS",
        ]

        for command in expected_wire_commands:
            with self.subTest(command=command):
                self.assertIn(f'wireCommand: "{command}"', app_js)

        expected_toggle_ids = [
            'data-toggle="relay1"',
            'data-toggle="relay4"',
            'data-toggle="pump1"',
            'data-toggle="pump2"',
            'data-toggle="compressor"',
            'data-toggle="outletValve"',
        ]
        index_html = (GUI_ROOT / "index.html").read_text(encoding="utf-8")
        for toggle_id in expected_toggle_ids:
            with self.subTest(toggle_id=toggle_id):
                self.assertIn(toggle_id, index_html)


if __name__ == "__main__":
    unittest.main()
