# Connect a ChatGPT plan

The private preview’s owner can choose a ChatGPT account, model and reasoning effort in **Settings**. Each account has its own preferences. Connecting and listing models do not run inference. A repair request uses the selected account’s plan. Check its usage limits and credit settings before permitting requests. [Manage ChatGPT usage](https://chatgpt.com/settings/usage)

## Configure the preview

1. Identify the existing SkyScrape owner’s user UUID from the authenticated owner’s `/api/v1/me` response. Confirm that it belongs to the intended person. The account can retain its analyst role.
2. In the API’s private environment file, set `CHATGPT_OWNER_ID` to that UUID and `CHATGPT_STATE_DIR` to an absolute directory outside the checkout owned by the API service user. Give the directory mode `0700`. Set `CHATGPT_CALLBACK_PORT` to an available port, normally `1455`.
3. Restart the private API with this configuration. For the localhost and Tailscale API processes on the same miniserver, use the same directory, database, owner UUID, master key and key version. Each keeps its own existing `APP_ORIGIN`. Back up the encrypted directory and encryption key separately. Keep the same key and version when restoring.
4. Sign in to the private workspace as the bound owner. Open **Settings**. Other users and API keys cannot access these controls.

Browsers share cookies across ports on one hostname. For a second preview backed by a cloned database, set `AUTH_COOKIE_PREFIX=skyscrape-review` on both API processes serving the clone. Leave the original preview’s setting unchanged to preserve its sessions. Use a distinct, stable prefix for each additional database, with 1–32 ASCII letters, digits, hyphens or underscores. Users sign in separately to the new preview.

## Connect from a browser

On the miniserver, go directly to step 2. On a different computer, use an SSH account with port forwarding access to the miniserver.

1. Open **Settings → Continue with ChatGPT** on the browser computer. For a remote hostname, Settings shows the tunnel command using the current hostname, configured callback port, and API service username. Set `CHATGPT_SSH_USER` in the private API environment if the SSH login differs, or replace the login when running the command. Run it in Windows Terminal (OpenSSH) or a terminal on the browser computer. A connected tunnel stays quiet. Keep it open through sign-in. The default port gives a command of this form.

   ```sh
   ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:1455:127.0.0.1:1455 USER@MINISERVER
   ```

2. Open the existing private SkyScrape URL on that computer. From a local browser select **Settings → Continue with ChatGPT**. From the remote browser select **Tunnel ready, continue**. This starts a fresh sign-in. Choose a workspace and review the permission to use your ChatGPT plan. The provider returns to the browser computer’s loopback address. The tunnel forwards that callback to the initiating API process. SkyScrape returns you to the original private workspace.
3. Choose an available model and reasoning effort, then select **Save preferences**. If the account catalog omits reasoning options, **Model default** lets the provider choose. Refresh Settings to check the saved selection.
4. To use another registration, choose **Add ChatGPT account** or connect a saved account. **Disconnect ChatGPT** attempts to revoke the selected renewable grant and clears its local tokens. If SkyScrape reports an unconfirmed revocation, disconnect the app in ChatGPT Settings.

A refused loopback connection usually means the tunnel is missing, the port differs, or a previous sign-in is still using it. Re-use an existing tunnel to the same server and port, or close the program occupying the local port and rerun the command. Return to Settings in the same browser and start a fresh sign-in. Discard old loopback links. Each pending sign-in expires after ten minutes. A failed account switch preserves the previously selected account. If the code expires during first registration, choose **Retry new registration** from the same signed-in browser session. **Add ChatGPT account** always starts a new registration. If you authorize identity only, the saved registration displays **Enable ChatGPT plan**. Select it to review plan permissions for that account. An expired or invalidated refresh grant requires reconnecting. When the provider reports a plan limit, review the app’s limits in ChatGPT usage settings. If the provider temporarily cannot check usage, try again later. A failed model-list request offers **Retry**.

SkyScrape keeps an encrypted host and account record on the miniserver. Its authorization listener opens on IPv4 loopback only during a sign-in. The Tailscale hostname is the application origin, while the provider’s callback always uses `127.0.0.1`. [OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [Self-hosted VM guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
