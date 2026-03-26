/**
 * Cloud-init user-data builder for EC2 Ubuntu instances.
 *
 * Returns a bash script that provisions a fresh instance with
 * all tooling needed to run Ark compute sessions.
 */

export function buildUserData(opts?: { idleMinutes?: number }): string {
  const idleMinutes = opts?.idleMinutes ?? 60;
  const tickMinutes = 10;
  const ticks = Math.ceil(idleMinutes / tickMinutes);

  // Build idle-shutdown script content separately so we can inject ticks/minutes
  // while keeping shell variables ($COUNT, $STATE, etc.) intact.
  const idleScript = [
    '#!/bin/bash',
    'STATE=/tmp/ark-idle-count',
    '',
    'if who | grep -q .; then',
    '  echo 0 > "$STATE"',
    '  exit 0',
    'fi',
    '',
    "CLAUDE_PIDS=$(pgrep -f 'claude' 2>/dev/null)",
    'if [ -n "$CLAUDE_PIDS" ]; then',
    '  for PID in $CLAUDE_PIDS; do',
    '    CHILDREN=$(pgrep -P "$PID" 2>/dev/null)',
    '    if [ -n "$CHILDREN" ]; then',
    '      echo 0 > "$STATE"',
    '      exit 0',
    '    fi',
    '    if ls /proc/"$PID"/fd 2>/dev/null | xargs -I{} readlink /proc/"$PID"/fd/{} 2>/dev/null | grep -q \'socket:\'; then',
    '      CONNS=$(ss -tnp 2>/dev/null | grep "pid=$PID" | grep -c \'ESTAB\')',
    '      if [ "$CONNS" -gt 0 ]; then',
    '        echo 0 > "$STATE"',
    '        exit 0',
    '      fi',
    '    fi',
    '  done',
    'fi',
    '',
    'COUNT=$(cat "$STATE" 2>/dev/null || echo 0)',
    'COUNT=$((COUNT + 1))',
    'echo "$COUNT" > "$STATE"',
    `logger "Ark: idle tick $COUNT/${ticks}"`,
    '',
    `if [ "$COUNT" -ge ${ticks} ]; then`,
    `  logger "Ark: all sessions idle for ${idleMinutes}m, shutting down"`,
    '  /sbin/shutdown -h now "Ark idle shutdown"',
    'fi',
  ].join('\n');

  return `#!/bin/bash
# NOTE: no set -e - flaky installs (rvm, gpg keys) must not kill the script

# ── Base packages ────────────────────────────────────────────────────────────
apt-get update
apt-get install -y git curl unzip build-essential jq rsync gnupg2 sysstat

# ── Node.js 22 ───────────────────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# ── Python 3.12+ ─────────────────────────────────────────────────────────────
apt-get install -y python3 python3-pip python3-venv

# ── Docker + Docker Compose + devcontainer CLI ───────────────────────────────
apt-get install -y docker.io docker-compose-v2
systemctl enable docker
usermod -aG docker ubuntu
npm install -g @devcontainers/cli

# ── AWS CLI v2 ───────────────────────────────────────────────────────────────
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
unzip /tmp/awscliv2.zip -d /tmp
/tmp/aws/install

# ── GitHub CLI ───────────────────────────────────────────────────────────────
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
apt-get update
apt-get install -y gh

# ── Claude Code (native installer - run as ubuntu, not root) ─────────────────
su - ubuntu -c 'curl -fsSL https://claude.ai/install.sh | bash'
echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/ubuntu/.bashrc
echo 'export COLORTERM=truecolor' >> /home/ubuntu/.bashrc

echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/ubuntu/.profile
echo 'export COLORTERM=truecolor' >> /home/ubuntu/.profile


# ── tmux ─────────────────────────────────────────────────────────────────────
apt-get install -y tmux

# ── bun (install as ubuntu) ──────────────────────────────────────────────────
su - ubuntu -c 'curl -fsSL https://bun.sh/install | bash'
echo 'export BUN_INSTALL="$HOME/.bun"' >> /home/ubuntu/.bashrc
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /home/ubuntu/.bashrc

# ── nvm (install as ubuntu) ──────────────────────────────────────────────────
su - ubuntu -c 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash' || true

# ── kubectl ──────────────────────────────────────────────────────────────────
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.32/deb/Release.key \\
  | gpg --dearmor -o /usr/share/keyrings/kubernetes-apt-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.32/deb/ /" \\
  | tee /etc/apt/sources.list.d/kubernetes.list
apt-get update
apt-get install -y kubectl

# ── helm ─────────────────────────────────────────────────────────────────────
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# ── Ark binary (for MCP channel on remote sessions) ──────────────────────────
su - ubuntu -c 'curl -fsSL https://ytarasova.github.io/ark/install.sh | bash -s -- --latest'

# ── Workspace ────────────────────────────────────────────────────────────────
mkdir -p /home/ubuntu/Projects
chown -R ubuntu:ubuntu /home/ubuntu/Projects

# ── Tmux config: mouse scroll, history 50k, allow-passthrough, Ctrl+Q detach ─
cat > /home/ubuntu/.tmux.conf <<'TMUX'
set -g mouse on
set -g history-limit 50000
set -ga update-environment "TERM TERM_PROGRAM COLORTERM"
bind-key -n C-q detach-client
set -g status-left ""
set -g status-right " C-q detach | #{session_name} "
set -g status-style "bg=colour235,fg=colour248"
set -g status-right-style "bg=colour235,fg=colour214"
TMUX
# allow-passthrough requires tmux 3.3+
if tmux -V | awk '{if ($2+0 >= 3.3) exit 0; else exit 1}'; then
  echo 'set -g allow-passthrough on' >> /home/ubuntu/.tmux.conf
fi
chown ubuntu:ubuntu /home/ubuntu/.tmux.conf

# ── Idle shutdown script (${idleMinutes}m with no active sessions) ───────────
cat > /usr/local/bin/ark-idle-shutdown <<'IDLE'
${idleScript}
IDLE
chmod +x /usr/local/bin/ark-idle-shutdown

# ── Cron: check every 10 minutes ────────────────────────────────────────────
cat > /etc/cron.d/ark-idle <<'CRON'
SHELL=/bin/bash
*/10 * * * * root /usr/local/bin/ark-idle-shutdown
CRON

# ── Ready marker ─────────────────────────────────────────────────────────────
echo "Ark provisioning complete" > /home/ubuntu/.ark-ready
chown ubuntu:ubuntu /home/ubuntu/.ark-ready
`;
}
