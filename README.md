# PTZ Cam Control

Small local controller for a VISCA-capable PTZ camera connected through an RS232-to-TCP bridge such as a Moxa serial device server.

I specifically built this for the [AVKANS NDI 20x Zoom Camera](https://amzn.to/4lHUsJa). But it should work with any camera supporting the VISCA protocol over serial. It would be easy to rewire this for a local serial connection, however im a fan of serial TCP servers.

## What it does

- Connects to a TCP endpoint exposed by your serial bridge.
- Sends common VISCA commands for pan, tilt, zoom, home, presets, and `IF_Clear`.
- Shows transmitted bytes and camera replies so you can debug protocol issues.
- Includes a raw hex sender for commands that are not yet mapped to buttons.


## Run it

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

If you want token-protected webhooks for Stream Deck, start it like this:

```bash
WEBHOOK_TOKEN=your-secret npm start
```

## Bridge setup

Configure the serial server to match the camera:

- Protocol mode on the camera: `VISCA`
- Physical control link: `RS232`
- Serial settings on the bridge: `9600 8N1` is the safest default if the camera is also set to 9600

The app itself only opens a plain TCP socket to the bridge. It does not configure the serial adapter.

## Headless Startup

The server now saves the last successful bridge connection to `bridge-state.json` and automatically attempts to reconnect to that same `host:port` every time the app starts.

- This makes headless use practical for Stream Deck control.
- The saved bridge target updates after a successful UI connect or `/hook/connect`.
- Manual disconnect does not erase the saved target, so the next app start will still try to reconnect.
- If the bridge is unavailable during startup, the server keeps retrying in the background every 5 seconds until it connects.
- A manual disconnect from the UI or `/hook/disconnect` pauses auto-reconnect until you connect again or restart the app.

## Built-in VISCA mappings

- Pan/Tilt drive: `8x 01 06 01 vv ww dd ee FF`
- Stop: `8x 01 06 01 vv ww 03 03 FF`
- Zoom tele/wide: `8x 01 04 07 2p FF` / `8x 01 04 07 3p FF`
- Zoom stop: `8x 01 04 07 00 FF`
- Home: `8x 01 06 04 FF`
- Preset reset/set/recall: `8x 01 04 3F 00/01/02 pp FF`

The app defaults to camera address `1`, so the normal header byte is `81`.
Preset numbers are sent exactly as entered in the UI so they match the camera remote numbering.

## Stream Deck / Webhook Control

The app now exposes simple local webhook endpoints so Stream Deck can trigger moves, presets, zoom, and raw commands without needing to speak VISCA directly.

- `GET /hook` returns a small JSON help payload with example URLs.
- `GET /hook/action/home` sends the Home command.
- `GET /hook/preset/1` recalls preset 1.
- `GET /hook/preset/4?mode=set` stores preset 4.
- `GET /hook/action/left?duration=250` moves left briefly, then auto-stops after 250 ms.
- `GET /hook/action/zoomTele?duration=200` zooms in briefly, then auto-stops.
- `GET /hook/action/stop` and `GET /hook/action/zoomStop` are also available.
- `GET /hook/raw?hex=81%2001%2006%2004%20FF` sends raw bytes.
- `GET /hook/connect?host=192.168.1.50&port=4001` reconnects the TCP bridge.
- `GET /hook/disconnect` closes the TCP bridge connection.

Supported parameters for `/hook/action/:action`:

- `duration` in milliseconds for movement or zoom nudges. Default is `350`.
- `panSpeed`, `tiltSpeed`, `zoomSpeed`, and `cameraAddress`.
- `hold=true` if you want to suppress the auto-stop and manage stop commands yourself.

Authentication:

- If `WEBHOOK_TOKEN` is set, each webhook must include `?token=your-secret`, an `X-PTZ-Token` header, or `Authorization: Bearer your-secret`.

Stream Deck options:

- Use an HTTP Request action if your Stream Deck setup has one.
- If you only have URL launching, a local GET URL works fine for simple triggers.

## Notes

- If the camera ignores commands, verify the camera menu is set to `VISCA` and the baud rate matches the bridge.
- Some VISCA cameras will not accept new commands until they finish initialization after power-on.
- If this camera turns out to expect a vendor-specific Pelco or VISCA extension, use the raw hex box first and then we can add the missing commands.
