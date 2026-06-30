# ScreenBoard public access

Local addresses like `https://192.168.1.9:5443` only work on the same Wi-Fi.
Students in another city need a public HTTPS URL.

## Option 1: Cloudflare Tunnel

Use Cloudflare Tunnel to publish the local ScreenBoard server without opening a router port.

Target service:

```text
http://localhost:5177
```

Cloudflare will provide a public HTTPS hostname. Share that URL with students.

Official docs:
https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/

## Option 2: ngrok

Use ngrok to create a temporary or static public HTTPS URL that forwards to the local app.

Target service:

```text
http://localhost:5177
```

Official docs:
https://ngrok.com/docs/http/

## Option 3: VPS or cloud server

Run ScreenBoard on a public server and put HTTPS in front of it with a domain.
This is the most stable option for real classes.

## Current presenter controls

Default presenter password:

```text
1234
```

To change it on Windows PowerShell before starting:

```powershell
$env:PRESENTER_PASSWORD="new-password"
node server.js
```

Only two presenter devices can join the same room by default. To change that:

```powershell
$env:MAX_PRESENTERS="2"
node server.js
```
