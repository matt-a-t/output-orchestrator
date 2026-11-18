#!/bin/bash
# Locks a thread's container down to the hosts it needs, after Anthropic's reference devcontainer firewall.
# The board runs it as root (`docker exec -u root <container> init-firewall [host|cidr]...`) each time the container
# starts, since a stopped container loses its rules. Egress is denied except to:
#   - claude's own services (api.anthropic.com, statsig.com, sentry.io) and the npm registry
#   - GitHub's web, API and git ranges
#   - the DNS servers in /etc/resolv.conf
#   - each host or CIDR given as an argument (the project's egress setting)
# Inbound, only replies and connections from the docker host (its published ports) get in.
# Any failure exits non-zero, and the board then removes the container rather than leave it open.
set -euo pipefail
IFS=$'\n\t'

DEFAULT_HOSTS=(
	api.anthropic.com
	statsig.com
	sentry.io
	registry.npmjs.org
)

warn() { echo "init-firewall: $*" >&2; }

valid_cidr() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$ ]]; }
valid_host() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; }

for arg in "$@"; do
	valid_cidr "$arg" || valid_host "$arg" || { warn "not a host name or IPv4 address/CIDR: $arg"; exit 1; }
done

# Start from nothing.
iptables -P INPUT ACCEPT
iptables -P OUTPUT ACCEPT
iptables -P FORWARD ACCEPT
iptables -F
iptables -X
ipset destroy allowed 2>/dev/null || true
ipset create allowed hash:net

# Loopback, and replies to what's already allowed.
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# DNS, only to the resolvers the container was given.
while read -r ns; do
	valid_cidr "$ns" || continue
	iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
	iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
done < <(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf)

# The docker host, which is where connections to the published ports come from. In only: the container
# can answer it, but not open connections to the host's own services.
gateway=$(ip route | awk '/^default/ { print $3; exit }')
[ -n "$gateway" ] || { warn "no default route"; exit 1; }
iptables -A INPUT -s "$gateway" -j ACCEPT

add() { ipset add -exist allowed "$1"; }

resolve() {
	local host=$1 ips
	ips=$(getent ahostsv4 "$host" | awk '{ print $1 }' | sort -u) || true
	if [ -z "$ips" ]; then
		warn "couldn't resolve $host; it stays blocked"
		return
	fi
	for ip in $ips; do add "$ip"; done
}

# GitHub publishes its ranges; a host name would only cover one of many addresses.
if meta=$(curl -fsS --max-time 10 https://api.github.com/meta); then
	while read -r cidr; do
		valid_cidr "$cidr" && add "$cidr"
	done < <(echo "$meta" | jq -r '(.web + .api + .git)[] | select(contains(":") | not)')
else
	warn "couldn't fetch GitHub's ranges; github.com stays blocked"
fi

for host in "${DEFAULT_HOSTS[@]}"; do resolve "$host"; done
for arg in "$@"; do
	if valid_cidr "$arg"; then add "$arg"; else resolve "$arg"; fi
done

iptables -A OUTPUT -m set --match-set allowed dst -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# No IPv6 at all, where the container has it.
if command -v ip6tables >/dev/null && ip6tables -L >/dev/null 2>&1; then
	ip6tables -F
	ip6tables -A INPUT -i lo -j ACCEPT
	ip6tables -A OUTPUT -o lo -j ACCEPT
	ip6tables -P INPUT DROP
	ip6tables -P FORWARD DROP
	ip6tables -P OUTPUT DROP
fi

# Check it took: somewhere not on the list mustn't answer.
if curl -fsS --max-time 5 https://example.com >/dev/null 2>&1; then
	warn "example.com is still reachable, so the firewall isn't working"
	exit 1
fi
