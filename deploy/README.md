# Running Harvester on AWS

This is how the server was set up, and how to look after it. Everything here uses the AWS CLI with a profile called `harvester`
(an IAM user that may only manage Lightsail). Nothing in this folder contains a key or a password.

## What exists

| Thing | Name / value |
|---|---|
| Lightsail instance | `harvester` in `eu-central-1a` (Frankfurt), Ubuntu 24.04, bundle `small_3_0` (2 GB, 2 vCPU, 60 GB), about $12 a month |
| Fixed IP | `harvester-ip` (attached to the instance) |
| SSH key pair | `harvester-deploy`, private key in `~/.ssh/harvester-aws.pem` on the PC that created it |
| Service | `harvester` (systemd), program in `/opt/harvester`, settings in `/opt/harvester/.env` (owner `harvester`, mode 600) |
| Private access | Tailscale; the page is served inside the tailnet at `https://<machine>.<tailnet>.ts.net/` (`tailscale serve`) |
| Firewall | only TCP 22 (SSH) from one address; the web page is **not** open to the internet |

Frankfurt was chosen because Binance blocks many US addresses (checked: both the testnet and the live futures API answer from the server).

## Updating the server

From the repository root in Git Bash, with Docker Desktop running:

```
bash deploy/update.sh
```

It builds the page and the Linux program, copies them to the server and restarts the service. The `.env` on the server is not touched.
(The program is built in a Debian 11 container so it also runs on older Ubuntu releases. It is only built there, never run: it would read the
`.env` next to it and start for real.)

## Looking after it

```
ssh -i ~/.ssh/harvester-aws.pem ubuntu@<ip>
sudo systemctl status harvester          # is it running
sudo journalctl -u harvester -f          # the live log (also /opt/harvester/Harvester/harvester.log)
sudo systemctl restart harvester
sudo nano /opt/harvester/.env            # change settings, then restart. Keep Unix line endings (no CR characters).
```

Telegram `/health` shows the same from your phone. If the 30-minute summary stops arriving, the server is down or has lost Binance.

Only ONE Harvester program may use the Telegram bot and process held / armed orders: do not start another copy (for example the desktop app or
a server on a PC) while this one runs.

## When your home IP changes (SSH stops working)

```
aws lightsail put-instance-public-ports --profile harvester --region eu-central-1 --instance-name harvester \
  --port-infos "fromPort=22,toPort=22,protocol=tcp,cidrs=<your new IP>/32"
```

(Your address: `curl https://checkip.amazonaws.com`.) Once Tailscale works on your PC you can also close port 22 completely and SSH over Tailscale.

## Setting it up again from nothing

1. `aws lightsail create-key-pair --key-pair-name harvester-deploy` (save the private key at once: it is shown only once).
2. `aws lightsail create-instances --instance-names harvester --availability-zone eu-central-1a --blueprint-id ubuntu_24_04 --bundle-id small_3_0 --key-pair-name harvester-deploy`
3. `aws lightsail allocate-static-ip --static-ip-name harvester-ip`, then `attach-static-ip` to the instance.
4. Close everything but SSH from your address (`put-instance-public-ports`, as above).
5. Copy `deploy/` to the server and run `sudo bash setup-server.sh`; copy the program, `ui/dist` and a `.env` (with Unix line endings) to `/opt/harvester`.
6. `sudo tailscale up --hostname=harvester` (open the link it prints), turn on MagicDNS, HTTPS certificates and Serve in the Tailscale admin console, then
   `sudo tailscale serve --bg --https=443 http://127.0.0.1:8787`.
7. `sudo systemctl start harvester`.

## Security notes

- The `.env` holds the Binance keys, the Telegram bot token, the Anthropic key and the web access token. Keep it out of git and chat.
- Give the Binance key the least it needs (futures trading, no withdrawals) and, for the live exchange, restrict it to the server's fixed IP.
- Delete the AWS access key of the deploy user when you do not need it. Rotate the web token and the bot token if they ever appear somewhere they should not.
- Going live (`HARVESTER_ENV=live` and live keys in `.env`) is a deliberate step: check the limits (`MAX_ORDER_NOTIONAL`, `MAX_LEVERAGE`) first.

## Removing everything

```
aws lightsail delete-instance --instance-name harvester
aws lightsail release-static-ip --static-ip-name harvester-ip
aws lightsail delete-key-pair --key-pair-name harvester-deploy
```
