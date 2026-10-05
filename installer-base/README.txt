Patchbay Gateway - Claude Desktop setup
=======================================

This connects your Claude Desktop app to your organisation's MCP gateway.

TO INSTALL:
  1. Unzip this whole folder somewhere (e.g. your Desktop).
  2. Double-click "Install.bat".
  3. If Windows shows a blue "Windows protected your PC" box, click
     "More info" -> "Run anyway" (this is normal for in-house tools).
  4. Follow the prompt, then fully quit and restart Claude Desktop.

That's it. Nothing else needs to be installed - Node.js and everything
else is included in this bundle.

Your personal access token is baked into params.json in this folder. Don't
share this bundle with anyone else - each person gets their own.

If something goes wrong, your previous Claude config is saved next to the
original as "claude_desktop_config.json.bak".
