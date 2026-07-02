# MIRAGE Ground Station GUI

Open `index.html` in a browser to run the mock MIRAGE mission-control console. No backend or package install is required.

## Replacement Points

The current app uses mock layers in `src/app.js`:

- `MockTelemetrySource` emits 1 Hz telemetry frames and dropout events.
- `MockMirageSimulator` owns the synthetic MIRAGE state model.
- `MockCommandRouter` simulates uplink queueing, ACK/NACK delays, and command effects.

When flight software and E-Link routing exist, replace those classes with real downlink/uplink adapters while keeping the UI rendering functions and command IDs stable.

## Operator Scope

The console is arranged as the required four-quadrant tool:

- top left: timestamped operations log
- top right: live telemetry plots and health metrics
- bottom left: explicit mission command buttons
- bottom right: manual command terminal
