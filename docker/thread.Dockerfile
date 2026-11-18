# The reference image for a project's thread containers: node, claude, git, and the firewall oo runs as each
# container starts. Build it from this directory:
#
#   docker build -t oo-thread -f thread.Dockerfile .
#
# and set `oo-thread` as the project's container in the projects screen (P). For a project that needs more
# (python, a database client, ...), make its own image FROM oo-thread and add them.
#
# oo runs the container as you (your uid and gid), with your home's path, so nothing here needs a user.

FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates curl git iproute2 ipset iptables jq less openssh-client procps \
	&& rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

COPY init-firewall.sh /usr/local/bin/init-firewall
RUN chmod 755 /usr/local/bin/init-firewall

# Rebuild the image to update claude: the firewall blocks its downloads, and every container would update alone.
ENV DISABLE_AUTOUPDATER=1
