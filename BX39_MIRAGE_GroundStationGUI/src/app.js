(function () {
  "use strict";

  const MAX_SAMPLES = 120;
  const TELEMETRY_PERIOD_MS = 1000;

  const COMMANDS = {
    startExperiment: {
      label: "start experiment",
      aliases: ["start experiment", "start measurements", "measurements", "start"],
      effect: function (sim) {
        sim.mode = "MEASUREMENTS";
        sim.pressurisationActive = true;
        sim.outletValveOpen = false;
        sim.emergencyStopped = false;
        return "autonomous Measurements loop requested";
      }
    },
    enterStandby: {
      label: "enter standby",
      aliases: ["enter standby", "standby", "hold"],
      effect: function (sim) {
        sim.mode = "STANDBY";
        sim.pressurisationActive = false;
        return "autonomous Standby loop requested";
      }
    },
    startPressurisation: {
      label: "start pressurisation",
      aliases: ["start pressurisation", "start pressurization", "pressurise", "pressurize"],
      effect: function (sim) {
        sim.pressurisationActive = true;
        sim.outletValveOpen = false;
        return "pressure MCU enabled pumps and compressor";
      }
    },
    stopPressurisation: {
      label: "stop pressurisation",
      aliases: ["stop pressurisation", "stop pressurization", "stop pressure"],
      effect: function (sim) {
        sim.pressurisationActive = false;
        return "pressure MCU disabled pumps and compressor";
      }
    },
    openOutletValve: {
      label: "open outlet valve",
      aliases: ["open outlet valve", "open valve", "outlet open"],
      effect: function (sim) {
        sim.outletValveOpen = true;
        return "normally closed outlet valve commanded open";
      }
    },
    closeOutletValve: {
      label: "close outlet valve",
      aliases: ["close outlet valve", "close valve", "outlet close"],
      effect: function (sim) {
        sim.outletValveOpen = false;
        return "outlet valve commanded closed";
      }
    },
    enableHeating: {
      label: "enable heating",
      aliases: ["enable heating", "heating on", "heat on"],
      effect: function (sim) {
        sim.heatingEnabled = true;
        return "thermal MCU heater loops enabled";
      }
    },
    disableHeating: {
      label: "disable heating",
      aliases: ["disable heating", "heating off", "heat off"],
      effect: function (sim) {
        sim.heatingEnabled = false;
        return "thermal MCU heater loops disabled";
      }
    },
    enableCooling: {
      label: "enable cooling",
      aliases: ["enable cooling", "cooling on", "peltier on"],
      effect: function (sim) {
        sim.coolingEnabled = true;
        return "Peltier cooler loop enabled";
      }
    },
    disableCooling: {
      label: "disable cooling",
      aliases: ["disable cooling", "cooling off", "peltier off"],
      effect: function (sim) {
        sim.coolingEnabled = false;
        return "Peltier cooler loop disabled";
      }
    },
    flushChamber: {
      label: "flush chamber",
      aliases: ["flush chamber", "flush", "purge chamber"],
      effect: function (sim) {
        sim.flushTicks = 8;
        sim.outletValveOpen = true;
        sim.pressurisationActive = true;
        return "flush sequence started with fresh ambient-air exchange";
      }
    },
    requestStatus: {
      label: "request status update",
      aliases: ["request status update", "status update", "status"],
      effect: function (sim) {
        sim.forceStatusEvent = true;
        return "status snapshot requested from main MCU";
      }
    },
    restartController: {
      label: "restart main controller",
      aliases: ["restart main controller", "restart controller", "reboot mcu", "reboot"],
      disruptive: true,
      effect: function (sim) {
        sim.controllerRebootTicks = 4;
        sim.mode = "STANDBY";
        sim.pressurisationActive = false;
        return "main MCU reboot sequence started";
      }
    },
    emergencyStop: {
      label: "emergency stop / safe shutdown",
      aliases: ["emergency stop", "safe shutdown", "shutdown", "estop", "e-stop"],
      disruptive: true,
      effect: function (sim) {
        sim.emergencyStopped = true;
        sim.mode = "SAFE";
        sim.pressurisationActive = false;
        sim.heatingEnabled = false;
        sim.coolingEnabled = false;
        sim.outletValveOpen = true;
        sim.forcedFaultTicks = 14;
        return "safe shutdown latched; loads disabled and outlet opened";
      }
    },
    pingExperiment: {
      label: "ping experiment",
      aliases: ["ping experiment", "ping", "heartbeat"],
      effect: function () {
        return "experiment heartbeat returned";
      }
    }
  };

  const dom = {
    overallHealth: document.getElementById("overallHealth"),
    missionMode: document.getElementById("missionMode"),
    linkState: document.getElementById("linkState"),
    lastFrameAge: document.getElementById("lastFrameAge"),
    storageState: document.getElementById("storageState"),
    controllerState: document.getElementById("controllerState"),
    logFeed: document.getElementById("logFeed"),
    frameNumber: document.getElementById("frameNumber"),
    latencyValue: document.getElementById("latencyValue"),
    methaneValue: document.getElementById("methaneValue"),
    chamberPressureValue: document.getElementById("chamberPressureValue"),
    chamberTempValue: document.getElementById("chamberTempValue"),
    humidityValue: document.getElementById("humidityValue"),
    linkQualityValue: document.getElementById("linkQualityValue"),
    metricMethane: document.getElementById("metricMethane"),
    metricPressure: document.getElementById("metricPressure"),
    metricTemperature: document.getElementById("metricTemperature"),
    metricHumidity: document.getElementById("metricHumidity"),
    metricLink: document.getElementById("metricLink"),
    commandStatus: document.getElementById("commandStatus"),
    terminalOutput: document.getElementById("terminalOutput"),
    terminalForm: document.getElementById("terminalForm"),
    terminalInput: document.getElementById("terminalInput"),
    terminalRoute: document.getElementById("terminalRoute"),
    gasChart: document.getElementById("gasChart"),
    pressureChart: document.getElementById("pressureChart"),
    thermalChart: document.getElementById("thermalChart"),
    linkChart: document.getElementById("linkChart")
  };

  const commandAliases = buildCommandAliases(COMMANDS);
  const history = [];
  let latestTelemetry = null;
  let lastGoodFrameAt = 0;
  let previousHealth = "unknown";
  let previousLinkStatus = "unknown";

  class OperationsLog {
    constructor(feedElement) {
      this.feedElement = feedElement;
      this.entries = [];
    }

    add(level, title, message) {
      const entry = {
        level: level || "info",
        title: title,
        message: message,
        time: new Date()
      };

      this.entries.unshift(entry);
      this.entries = this.entries.slice(0, 90);
      this.render();
    }

    render() {
      this.feedElement.textContent = "";
      const fragment = document.createDocumentFragment();

      this.entries.forEach(function (entry) {
        const item = document.createElement("li");
        item.className = "log-entry " + entry.level;

        const time = document.createElement("time");
        time.dateTime = entry.time.toISOString();
        time.textContent = formatClock(entry.time);

        const body = document.createElement("div");
        const title = document.createElement("strong");
        const message = document.createElement("p");
        title.textContent = entry.title;
        message.textContent = entry.message;

        body.append(title, message);
        item.append(time, body);
        fragment.append(item);
      });

      this.feedElement.append(fragment);
    }
  }

  class Terminal {
    constructor(outputElement) {
      this.outputElement = outputElement;
    }

    write(text, level) {
      const line = document.createElement("p");
      const time = document.createElement("span");
      const body = document.createElement("span");
      const className = level === "error" ? "error-line" : level === "warn" ? "warn-line" : "";

      line.className = "terminal-line " + className;
      time.className = "time";
      time.textContent = "[" + formatClock(new Date()) + "] ";
      body.textContent = text;
      line.append(time, body);
      this.outputElement.append(line);
      this.outputElement.scrollTop = this.outputElement.scrollHeight;
    }

    command(text) {
      const line = document.createElement("p");
      line.className = "terminal-line command-line";
      line.textContent = "> " + text;
      this.outputElement.append(line);
      this.outputElement.scrollTop = this.outputElement.scrollHeight;
    }

    clear() {
      this.outputElement.textContent = "";
    }
  }

  class MockMirageSimulator {
    constructor() {
      this.tick = 0;
      this.seq = 0;
      this.mode = "STANDBY";
      this.health = "healthy";
      this.linkStatus = "ONLINE";
      this.pressurisationActive = false;
      this.outletValveOpen = false;
      this.heatingEnabled = true;
      this.coolingEnabled = false;
      this.emergencyStopped = false;
      this.controllerRebootTicks = 0;
      this.flushTicks = 0;
      this.forcedFaultTicks = 0;
      this.forceStatusEvent = false;
      this.scenario = { name: "healthy", remaining: 18 };

      this.values = {
        methanePpm: 1.86,
        co2Ppm: 416,
        waterPpm: 3100,
        chamberPressureBar: 2.82,
        chamberTempC: 21.5,
        electronicsTempC: 26.0,
        humidityRh: 38,
        ambientPressureHpa: 1012,
        ambientTempC: 6,
        linkQuality: 98,
        latencyMs: 74,
        storageFreePct: 93
      };
    }

    generateFrame() {
      this.tick += 1;

      if (this.controllerRebootTicks > 0) {
        this.controllerRebootTicks -= 1;
        return this.dropoutFrame("main MCU rebooting");
      }

      this.advanceScenario();

      if (this.scenario.name === "dropout") {
        this.scenario.remaining -= 1;
        return this.dropoutFrame("E-Link frame missing");
      }

      this.seq += 1;
      this.updateEnvironment();

      const health = this.evaluateHealth();
      this.health = health;
      this.linkStatus = this.values.linkQuality < 62 ? "DEGRADED" : "ONLINE";

      return {
        valid: true,
        timestamp: Date.now(),
        seq: this.seq,
        mode: this.mode,
        health: health,
        linkStatus: this.linkStatus,
        linkQuality: this.values.linkQuality,
        latencyMs: this.values.latencyMs,
        methanePpm: this.values.methanePpm,
        co2Ppm: this.values.co2Ppm,
        waterPpm: this.values.waterPpm,
        chamberPressureBar: this.values.chamberPressureBar,
        chamberTempC: this.values.chamberTempC,
        electronicsTempC: this.values.electronicsTempC,
        humidityRh: this.values.humidityRh,
        ambientPressureHpa: this.values.ambientPressureHpa,
        ambientTempC: this.values.ambientTempC,
        pumpDutyPct: this.pressurisationActive ? clamp(68 + noise(8), 0, 100) : 0,
        compressorDutyPct: this.pressurisationActive ? clamp(58 + noise(10), 0, 100) : 0,
        heaterDutyPct: this.heatingEnabled ? clamp(36 + (22 - this.values.chamberTempC) * 4 + noise(5), 0, 100) : 0,
        coolerDutyPct: this.coolingEnabled ? clamp(26 + (this.values.chamberTempC - 24) * 4 + noise(5), 0, 100) : 0,
        outletValveOpen: this.outletValveOpen,
        onboardLogging: true,
        storageFreePct: this.values.storageFreePct,
        controller: "MAIN_MCU_READY",
        scenario: this.scenario.name,
        statusText: this.statusText()
      };
    }

    dropoutFrame(reason) {
      this.linkStatus = "DROPOUT";
      this.values.linkQuality = clamp(this.values.linkQuality - 24 + noise(3), 0, 100);
      this.values.latencyMs = 0;

      return {
        valid: false,
        timestamp: Date.now(),
        seq: this.seq,
        mode: this.mode,
        health: this.emergencyStopped ? "fault" : "dropout",
        linkStatus: "DROPOUT",
        linkQuality: 0,
        latencyMs: 0,
        dropoutReason: reason,
        controller: this.controllerRebootTicks > 0 ? "MAIN_MCU_REBOOTING" : "LINK_DROP"
      };
    }

    advanceScenario() {
      if (this.forcedFaultTicks > 0) {
        this.forcedFaultTicks -= 1;
        this.scenario = { name: "safe-shutdown", remaining: this.forcedFaultTicks };
        return;
      }

      this.scenario.remaining -= 1;
      if (this.scenario.remaining > 0) {
        return;
      }

      const roll = Math.random();
      if (roll < 0.56) {
        this.scenario = { name: "healthy", remaining: randInt(12, 26) };
      } else if (roll < 0.70) {
        this.scenario = { name: "humidity-warning", remaining: randInt(7, 14) };
      } else if (roll < 0.82) {
        this.scenario = { name: "pressure-warning", remaining: randInt(7, 15) };
      } else if (roll < 0.91) {
        this.scenario = { name: "thermal-warning", remaining: randInt(6, 13) };
      } else if (roll < 0.97) {
        this.scenario = { name: "dropout", remaining: randInt(3, 7) };
      } else {
        this.scenario = { name: "fault", remaining: randInt(5, 10) };
      }
    }

    updateEnvironment() {
      const descentCycle = Math.sin(this.tick / 520);
      const ambientTarget = clamp(990 - this.tick * 0.55 + descentCycle * 18, 72, 1015);
      this.values.ambientPressureHpa = approach(this.values.ambientPressureHpa, ambientTarget, 0.012) + noise(0.5);
      const altitudeFactor = clamp((1010 - this.values.ambientPressureHpa) / 935, 0, 1);
      this.values.ambientTempC = clamp(8 - altitudeFactor * 88 + Math.sin(this.tick / 40) * 2 + noise(0.6), -82, 16);

      let pressureTarget = 1.08;
      if (this.mode === "MEASUREMENTS" || this.pressurisationActive) {
        pressureTarget = 3.0;
      } else if (!this.outletValveOpen) {
        pressureTarget = 2.1;
      }

      if (this.outletValveOpen && !this.pressurisationActive) {
        pressureTarget = 1.08;
      }

      if (this.scenario.name === "pressure-warning") {
        pressureTarget += Math.random() > 0.5 ? 0.32 : -0.36;
      }

      if (this.scenario.name === "fault") {
        pressureTarget += 0.72;
      }

      if (this.scenario.name === "safe-shutdown") {
        pressureTarget = 1.05;
      }

      if (this.flushTicks > 0) {
        this.flushTicks -= 1;
        pressureTarget = 2.68 + noise(0.08);
        this.values.humidityRh = approach(this.values.humidityRh, 28, 0.22);
        this.values.waterPpm = approach(this.values.waterPpm, 1800, 0.25);
        if (this.flushTicks === 0) {
          this.outletValveOpen = false;
        }
      }

      this.values.chamberPressureBar = clamp(approach(this.values.chamberPressureBar, pressureTarget, 0.18) + noise(0.015), 0.85, 4.25);

      let chamberTarget = 21.5;
      if (!this.heatingEnabled) {
        chamberTarget -= 8 + altitudeFactor * 12;
      }
      if (this.coolingEnabled) {
        chamberTarget -= 4;
      }
      if (this.pressurisationActive) {
        chamberTarget += 1.8;
      }
      if (this.scenario.name === "thermal-warning") {
        chamberTarget += Math.random() > 0.45 ? 21 : -15;
      }
      if (this.scenario.name === "fault") {
        chamberTarget += 28;
      }
      if (this.scenario.name === "safe-shutdown") {
        chamberTarget = 13;
      }

      this.values.chamberTempC = clamp(approach(this.values.chamberTempC, chamberTarget, 0.08) + noise(0.12), -18, 65);
      this.values.electronicsTempC = clamp(approach(this.values.electronicsTempC, this.values.chamberTempC + 4 + (this.pressurisationActive ? 3 : 0), 0.06) + noise(0.16), -12, 72);

      let humidityTarget = 38 + altitudeFactor * 10;
      if (this.scenario.name === "humidity-warning") {
        humidityTarget = 74 + noise(5);
      }
      if (this.values.chamberTempC < 14) {
        humidityTarget += 11;
      }
      if (this.outletValveOpen && this.flushTicks > 0) {
        humidityTarget = 28;
      }

      this.values.humidityRh = clamp(approach(this.values.humidityRh, humidityTarget, 0.11) + noise(0.8), 12, 94);
      this.values.waterPpm = clamp(approach(this.values.waterPpm, 780 + this.values.humidityRh * 68 + altitudeFactor * 600, 0.14) + noise(45), 500, 7200);

      const gasPulse = Math.sin(this.tick / 18) * 0.025;
      this.values.methanePpm = clamp(1.86 + altitudeFactor * 0.11 + gasPulse + noise(0.015), 1.55, 2.35);
      this.values.co2Ppm = clamp(416 - altitudeFactor * 12 + Math.sin(this.tick / 22) * 4 + noise(2.2), 370, 450);

      let linkTarget = 97;
      if (this.scenario.name === "humidity-warning" || this.scenario.name === "pressure-warning") {
        linkTarget = 88;
      }
      if (this.scenario.name === "thermal-warning") {
        linkTarget = 82;
      }
      if (this.scenario.name === "fault") {
        linkTarget = 67;
      }
      if (this.scenario.name === "safe-shutdown") {
        linkTarget = 92;
      }

      this.values.linkQuality = clamp(approach(this.values.linkQuality, linkTarget, 0.21) + noise(2.8), 18, 100);
      this.values.latencyMs = Math.round(clamp(70 + (100 - this.values.linkQuality) * 3 + noise(15), 42, 420));
      this.values.storageFreePct = clamp(this.values.storageFreePct - 0.006, 12, 100);
    }

    evaluateHealth() {
      if (this.emergencyStopped || this.scenario.name === "safe-shutdown") {
        return "fault";
      }

      if (
        this.values.chamberPressureBar > 3.55 ||
        this.values.chamberPressureBar < 2.35 ||
        this.values.chamberTempC > 50 ||
        this.values.chamberTempC < 5 ||
        this.values.electronicsTempC > 58 ||
        this.values.humidityRh > 84
      ) {
        return "fault";
      }

      if (
        this.values.chamberPressureBar > 3.22 ||
        this.values.chamberPressureBar < 2.74 ||
        this.values.chamberTempC > 40 ||
        this.values.chamberTempC < 15 ||
        this.values.electronicsTempC > 48 ||
        this.values.humidityRh > 65 ||
        this.values.linkQuality < 75
      ) {
        return "warning";
      }

      return "healthy";
    }

    statusText() {
      if (this.emergencyStopped) {
        return "safe shutdown latched";
      }
      if (this.flushTicks > 0) {
        return "chamber flush active";
      }
      if (this.scenario.name === "humidity-warning") {
        return "humidity protection loop near threshold";
      }
      if (this.scenario.name === "pressure-warning") {
        return "pressure controller outside target band";
      }
      if (this.scenario.name === "thermal-warning") {
        return "thermal control margin reduced";
      }
      if (this.scenario.name === "fault") {
        return "fault injection active in mock telemetry";
      }
      return "nominal autonomous supervision";
    }

    applyCommand(commandId) {
      const definition = COMMANDS[commandId];
      if (!definition) {
        return "unknown command";
      }
      return definition.effect(this);
    }
  }

  class MockTelemetrySource {
    constructor(simulator, onFrame, onLogEvent) {
      this.simulator = simulator;
      this.onFrame = onFrame;
      this.onLogEvent = onLogEvent;
      this.timer = null;
    }

    start() {
      this.emit();
      this.timer = window.setInterval(this.emit.bind(this), TELEMETRY_PERIOD_MS);
    }

    stop() {
      if (this.timer) {
        window.clearInterval(this.timer);
      }
    }

    emit() {
      const sample = this.simulator.generateFrame();
      this.onFrame(sample);
      this.logFrame(sample);
    }

    logFrame(sample) {
      if (!sample.valid) {
        if (previousLinkStatus !== "DROPOUT") {
          this.onLogEvent("dropout", "Telemetry dropout", sample.dropoutReason + "; operator view is holding last valid data");
        }
        previousLinkStatus = "DROPOUT";
        return;
      }

      this.onLogEvent("info", "Telemetry frame " + sample.seq + " received", sample.statusText);

      if (previousLinkStatus === "DROPOUT") {
        this.onLogEvent("info", "E-Link recovered", "live telemetry resumed at frame " + sample.seq);
      }

      if (sample.health !== previousHealth && previousHealth !== "unknown") {
        const level = sample.health === "healthy" ? "info" : sample.health === "warning" ? "warn" : "fault";
        this.onLogEvent(level, "Health state changed", "system is now " + sample.health.toUpperCase());
      }

      previousHealth = sample.health;
      previousLinkStatus = sample.linkStatus;
    }
  }

  class MockCommandRouter {
    constructor(simulator) {
      this.simulator = simulator;
      this.listeners = [];
    }

    on(listener) {
      this.listeners.push(listener);
    }

    emit(event) {
      this.listeners.forEach(function (listener) {
        listener(event);
      });
    }

    send(commandId, origin) {
      const definition = COMMANDS[commandId];
      const requestId = "CMD-" + Math.floor(1000 + Math.random() * 9000);
      const delay = randInt(420, 1900);
      const linkPenalty = this.simulator.linkStatus === "DROPOUT" ? 0.34 : 0;
      const failChance = definition && definition.disruptive ? 0.1 + linkPenalty : 0.055 + linkPenalty;

      if (!definition) {
        return Promise.reject(new Error("unknown command"));
      }

      this.emit({
        type: "queued",
        commandId: commandId,
        label: definition.label,
        requestId: requestId,
        origin: origin,
        delay: delay
      });

      return new Promise((resolve, reject) => {
        window.setTimeout(() => {
          if (Math.random() < failChance) {
            const error = {
              type: "nack",
              commandId: commandId,
              label: definition.label,
              requestId: requestId,
              origin: origin,
              message: "mock uplink did not receive a valid ACK before timeout"
            };
            this.emit(error);
            reject(error);
            return;
          }

          const result = this.simulator.applyCommand(commandId);
          const ack = {
            type: "ack",
            commandId: commandId,
            label: definition.label,
            requestId: requestId,
            origin: origin,
            message: result
          };
          this.emit(ack);
          resolve(ack);
        }, delay);
      });
    }
  }

  const log = new OperationsLog(dom.logFeed);
  const terminal = new Terminal(dom.terminalOutput);
  const simulator = new MockMirageSimulator();
  const commandRouter = new MockCommandRouter(simulator);
  const telemetrySource = new MockTelemetrySource(simulator, handleFrame, function (level, title, message) {
    log.add(level, title, message);
  });

  function init() {
    terminal.write("MIRAGE ground-station terminal ready on local mock route.");
    terminal.write("Type help for available manual commands.");
    log.add("info", "Ground station initialized", "mock telemetry and mock uplink adapters active");

    bindCommands();
    bindTerminal();
    commandRouter.on(handleCommandEvent);
    telemetrySource.start();
    window.setInterval(updateFrameAge, 1000);
    window.addEventListener("resize", drawAllCharts);
  }

  function bindCommands() {
    document.querySelectorAll("[data-command]").forEach(function (button) {
      button.addEventListener("click", function () {
        const commandId = button.dataset.command;
        if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) {
          return;
        }

        button.disabled = true;
        sendCommand(commandId, "button")
          .catch(function () {
            return undefined;
          })
          .finally(function () {
            button.disabled = false;
          });
      });
    });
  }

  function bindTerminal() {
    dom.terminalForm.addEventListener("submit", function (event) {
      event.preventDefault();
      const raw = dom.terminalInput.value.trim();
      if (!raw) {
        return;
      }

      dom.terminalInput.value = "";
      terminal.command(raw);
      handleTerminalCommand(raw);
    });
  }

  function handleTerminalCommand(raw) {
    const normalized = normalizeCommand(raw);

    if (normalized === "help") {
      terminal.write("commands: status, clear, start experiment, enter standby, start/stop pressurisation, open/close outlet valve, enable/disable heating, enable/disable cooling, flush chamber, restart main controller, emergency stop, ping experiment");
      return;
    }

    if (normalized === "clear") {
      terminal.clear();
      terminal.write("terminal cleared");
      return;
    }

    if (normalized === "status") {
      terminal.write(formatStatusLine(latestTelemetry));
      return;
    }

    const commandId = commandAliases[normalized];
    if (!commandId) {
      terminal.write("ERR UNKNOWN_COMMAND; type help for available mock uplink commands", "error");
      log.add("warn", "Manual command rejected", raw + " is not mapped to a mock uplink command");
      return;
    }

    if (COMMANDS[commandId].disruptive && !window.confirm("Route '" + COMMANDS[commandId].label + "' through mock uplink?")) {
      terminal.write("manual command cancelled locally", "warn");
      return;
    }

    sendCommand(commandId, "terminal").catch(function () {
      return undefined;
    });
  }

  function sendCommand(commandId, origin) {
    dom.commandStatus.textContent = "Uplink pending";
    return commandRouter.send(commandId, origin).catch(function (error) {
      return Promise.reject(error);
    });
  }

  function handleCommandEvent(event) {
    if (event.type === "queued") {
      const message = event.label + " queued as " + event.requestId + " from " + event.origin + "; mock delay " + event.delay + " ms";
      log.add("command", "Uplink queued", message);
      if (event.origin === "terminal") {
        terminal.write("QUEUED " + event.requestId + " " + event.label);
      }
      return;
    }

    if (event.type === "ack") {
      dom.commandStatus.textContent = "ACK " + event.requestId;
      log.add("command", "Command acknowledged", event.requestId + " " + event.label + "; " + event.message);
      if (event.origin === "terminal") {
        terminal.write("ACK " + event.requestId + " " + event.message);
      }
      window.setTimeout(function () {
        dom.commandStatus.textContent = "Ready";
      }, 2600);
      return;
    }

    if (event.type === "nack") {
      dom.commandStatus.textContent = "NACK " + event.requestId;
      log.add("fault", "Command failed", event.requestId + " " + event.label + "; " + event.message);
      if (event.origin === "terminal") {
        terminal.write("NACK " + event.requestId + " " + event.message, "error");
      }
      window.setTimeout(function () {
        dom.commandStatus.textContent = "Ready";
      }, 3200);
    }
  }

  function handleFrame(sample) {
    history.push(sample);
    while (history.length > MAX_SAMPLES) {
      history.shift();
    }

    if (sample.valid) {
      latestTelemetry = sample;
      lastGoodFrameAt = sample.timestamp;
    }

    renderTelemetry(sample);
    drawAllCharts();
  }

  function renderTelemetry(sample) {
    const display = sample.valid ? sample : latestTelemetry;
    const health = sample.valid ? sample.health : "dropout";
    const linkStatus = sample.valid ? sample.linkStatus : "DROPOUT";
    const linkQuality = sample.valid ? sample.linkQuality : 0;

    setChip(dom.overallHealth, healthLabel(health), health);
    setChip(dom.missionMode, display ? display.mode : simulator.mode, "neutral");
    setChip(dom.linkState, linkLabel(linkStatus), linkStatus === "ONLINE" ? "healthy" : linkStatus === "DEGRADED" ? "warning" : "dropout");

    dom.frameNumber.textContent = display && display.seq ? String(display.seq) : "--";
    dom.latencyValue.textContent = sample.valid ? sample.latencyMs + " ms" : "--";
    dom.storageState.textContent = display && display.onboardLogging ? "SD " + display.storageFreePct.toFixed(0) + "% free" : "SD logging";
    dom.controllerState.textContent = sample.controller === "MAIN_MCU_REBOOTING" ? "Main MCU rebooting" : sample.controller === "LINK_DROP" ? "awaiting frame" : "Main MCU ready";
    dom.terminalRoute.textContent = linkStatus === "DROPOUT" ? "mock route degraded" : "local mock route";

    if (display) {
      dom.methaneValue.textContent = display.methanePpm.toFixed(2);
      dom.chamberPressureValue.textContent = display.chamberPressureBar.toFixed(2);
      dom.chamberTempValue.textContent = display.chamberTempC.toFixed(1);
      dom.humidityValue.textContent = display.humidityRh.toFixed(0);
      dom.linkQualityValue.textContent = String(Math.round(linkQuality));

      setMetricState(dom.metricMethane, display.methanePpm < 1.65 || display.methanePpm > 2.25 ? "warning" : "healthy");
      setMetricState(dom.metricPressure, pressureState(display.chamberPressureBar));
      setMetricState(dom.metricTemperature, temperatureState(display.chamberTempC));
      setMetricState(dom.metricHumidity, humidityState(display.humidityRh));
      setMetricState(dom.metricLink, linkStatus === "DROPOUT" ? "dropout" : linkQuality < 75 ? "warning" : "healthy");
    }

    updateFrameAge();
  }

  function updateFrameAge() {
    if (!lastGoodFrameAt) {
      dom.lastFrameAge.textContent = "--";
      return;
    }

    const seconds = Math.max(0, Math.round((Date.now() - lastGoodFrameAt) / 1000));
    dom.lastFrameAge.textContent = seconds === 0 ? "now" : seconds + " s ago";
  }

  function drawAllCharts() {
    drawChart(dom.gasChart, history, {
      yLabel: "",
      series: [
        { key: "methanePpm", color: "#61d394", min: 1.5, max: 2.4 },
        { key: "co2Ppm", color: "#7aa6ff", min: 360, max: 460 },
        { key: "waterPpm", color: "#f0c15b", min: 500, max: 7200 }
      ]
    });

    drawChart(dom.pressureChart, history, {
      targetBand: { min: 2.85, max: 3.15, seriesMin: 2.2, seriesMax: 3.8 },
      series: [
        { key: "chamberPressureBar", color: "#5cc8c0", min: 2.2, max: 3.8 },
        { key: "ambientPressureHpa", color: "#b589ff", min: 50, max: 1020 }
      ]
    });

    drawChart(dom.thermalChart, history, {
      targetBand: { min: 19, max: 24, seriesMin: -20, seriesMax: 60 },
      series: [
        { key: "chamberTempC", color: "#ff9f57", min: -20, max: 60 },
        { key: "electronicsTempC", color: "#ff6b68", min: -20, max: 70 },
        { key: "humidityRh", color: "#7fd4ff", min: 0, max: 100 }
      ]
    });

    drawChart(dom.linkChart, history, {
      series: [
        { key: "linkQuality", color: "#61d394", min: 0, max: 100 },
        { key: "pumpDutyPct", color: "#f0c15b", min: 0, max: 100 },
        { key: "heaterDutyPct", color: "#ff9f57", min: 0, max: 100 }
      ]
    });
  }

  function drawChart(canvas, samples, config) {
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(260, Math.floor(rect.width));
    const height = Math.max(110, Math.floor(rect.height));
    const pixelWidth = Math.floor(width * dpr);
    const pixelHeight = Math.floor(height * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const pad = { left: 34, top: 8, right: 10, bottom: 20 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    ctx.fillStyle = "#111511";
    ctx.fillRect(0, 0, width, height);

    drawGrid(ctx, pad, plotW, plotH);
    drawDropouts(ctx, samples, pad, plotW, plotH);

    if (config.targetBand) {
      const y1 = yFor(config.targetBand.max, config.targetBand.seriesMin, config.targetBand.seriesMax, pad, plotH);
      const y2 = yFor(config.targetBand.min, config.targetBand.seriesMin, config.targetBand.seriesMax, pad, plotH);
      ctx.fillStyle = "rgba(97, 211, 148, 0.09)";
      ctx.fillRect(pad.left, y1, plotW, y2 - y1);
      ctx.strokeStyle = "rgba(97, 211, 148, 0.28)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, y1);
      ctx.lineTo(pad.left + plotW, y1);
      ctx.moveTo(pad.left, y2);
      ctx.lineTo(pad.left + plotW, y2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    config.series.forEach(function (series) {
      ctx.strokeStyle = series.color;
      ctx.lineWidth = 2;
      ctx.beginPath();

      let started = false;
      samples.forEach(function (sample, index) {
        const value = sample && sample.valid ? sample[series.key] : null;
        if (typeof value !== "number" || Number.isNaN(value)) {
          started = false;
          return;
        }

        const x = pad.left + xFor(index, samples.length, plotW);
        const y = yFor(value, series.min, series.max, pad, plotH);

        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
    });

    drawAxes(ctx, samples, pad, plotW, plotH);
  }

  function drawGrid(ctx, pad, plotW, plotH) {
    ctx.strokeStyle = "rgba(174, 184, 167, 0.12)";
    ctx.lineWidth = 1;

    for (let i = 0; i <= 4; i += 1) {
      const y = pad.top + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
    }

    for (let i = 0; i <= 5; i += 1) {
      const x = pad.left + (plotW / 5) * i;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();
    }
  }

  function drawDropouts(ctx, samples, pad, plotW, plotH) {
    if (samples.length < 2) {
      return;
    }

    ctx.fillStyle = "rgba(181, 137, 255, 0.12)";
    samples.forEach(function (sample, index) {
      if (sample.valid) {
        return;
      }
      const x = pad.left + xFor(index, samples.length, plotW);
      ctx.fillRect(x - 2, pad.top, 4, plotH);
    });
  }

  function drawAxes(ctx, samples, pad, plotW, plotH) {
    ctx.strokeStyle = "rgba(174, 184, 167, 0.26)";
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    ctx.fillStyle = "rgba(174, 184, 167, 0.72)";
    ctx.font = "11px Consolas, monospace";
    ctx.fillText("now", pad.left + plotW - 24, pad.top + plotH + 15);
    ctx.fillText("-" + Math.min(samples.length, MAX_SAMPLES) + "s", pad.left, pad.top + plotH + 15);
  }

  function xFor(index, length, plotW) {
    if (length <= 1) {
      return plotW;
    }
    return (index / Math.max(1, length - 1)) * plotW;
  }

  function yFor(value, min, max, pad, plotH) {
    const normalized = clamp((value - min) / (max - min), 0, 1);
    return pad.top + plotH - normalized * plotH;
  }

  function setChip(element, text, state) {
    element.textContent = text;
    element.classList.remove("chip-ok", "chip-warn", "chip-fault", "chip-dropout");

    if (state === "healthy") {
      element.classList.add("chip-ok");
    } else if (state === "warning") {
      element.classList.add("chip-warn");
    } else if (state === "fault") {
      element.classList.add("chip-fault");
    } else if (state === "dropout") {
      element.classList.add("chip-dropout");
    }
  }

  function setMetricState(element, state) {
    element.classList.remove("warn", "fault", "dropout");
    if (state === "warning") {
      element.classList.add("warn");
    } else if (state === "fault") {
      element.classList.add("fault");
    } else if (state === "dropout") {
      element.classList.add("dropout");
    }
  }

  function pressureState(value) {
    if (value < 2.35 || value > 3.55) {
      return "fault";
    }
    if (value < 2.74 || value > 3.22) {
      return "warning";
    }
    return "healthy";
  }

  function temperatureState(value) {
    if (value < 5 || value > 50) {
      return "fault";
    }
    if (value < 15 || value > 40) {
      return "warning";
    }
    return "healthy";
  }

  function humidityState(value) {
    if (value > 84) {
      return "fault";
    }
    if (value > 65) {
      return "warning";
    }
    return "healthy";
  }

  function healthLabel(health) {
    if (health === "healthy") {
      return "Healthy";
    }
    if (health === "warning") {
      return "Warning";
    }
    if (health === "fault") {
      return "Fault";
    }
    return "Dropout";
  }

  function linkLabel(status) {
    if (status === "ONLINE") {
      return "E-Link online";
    }
    if (status === "DEGRADED") {
      return "E-Link degraded";
    }
    return "E-Link dropout";
  }

  function formatStatusLine(sample) {
    if (!sample) {
      return "NO_VALID_TELEMETRY";
    }

    return [
      "MODE=" + sample.mode,
      "HEALTH=" + sample.health.toUpperCase(),
      "CH4=" + sample.methanePpm.toFixed(2) + "ppm",
      "CO2=" + sample.co2Ppm.toFixed(0) + "ppm",
      "H2O=" + sample.waterPpm.toFixed(0) + "ppm",
      "P_CHAMBER=" + sample.chamberPressureBar.toFixed(2) + "bar",
      "T_CHAMBER=" + sample.chamberTempC.toFixed(1) + "C",
      "RH=" + sample.humidityRh.toFixed(0) + "%",
      "LINK=" + sample.linkStatus
    ].join(" ");
  }

  function buildCommandAliases(commands) {
    const aliases = {};
    Object.keys(commands).forEach(function (commandId) {
      commands[commandId].aliases.forEach(function (alias) {
        aliases[normalizeCommand(alias)] = commandId;
      });
    });
    return aliases;
  }

  function normalizeCommand(value) {
    return value
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatClock(date) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function approach(current, target, factor) {
    return current + (target - current) * factor;
  }

  function noise(amount) {
    return (Math.random() - 0.5) * 2 * amount;
  }

  function randInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  init();
})();
