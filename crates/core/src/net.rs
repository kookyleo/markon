use local_ip_address::list_afinet_netifas;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::IpAddr;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindHostKind {
    Localhost,
    AllInterfaces,
    Interface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindHostOption {
    pub address: String,
    pub kind: BindHostKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface: Option<String>,
}

impl BindHostOption {
    fn localhost() -> Self {
        Self {
            address: "127.0.0.1".to_string(),
            kind: BindHostKind::Localhost,
            interface: None,
        }
    }

    fn all_interfaces() -> Self {
        Self {
            address: "0.0.0.0".to_string(),
            kind: BindHostKind::AllInterfaces,
            interface: None,
        }
    }
}

fn is_bindable_interface_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => !ipv4.is_loopback() && !ipv4.is_link_local() && !ipv4.is_unspecified(),
        // The rest of the app still formats host + port as `host:port`, which
        // does not work for bare IPv6 literals. Keep the surfaced choices to
        // IPv4 until the bind pipeline gains proper `[addr]:port` handling.
        IpAddr::V6(_) => false,
    }
}

fn collect_bind_hosts_from_iter<I>(ifaces: I) -> Vec<BindHostOption>
where
    I: IntoIterator<Item = (String, IpAddr)>,
{
    let mut hosts = vec![
        BindHostOption::localhost(),
        BindHostOption::all_interfaces(),
    ];
    let mut seen: HashSet<String> = hosts.iter().map(|host| host.address.clone()).collect();

    for (interface, ip) in ifaces {
        if !is_bindable_interface_ip(&ip) {
            continue;
        }
        let address = ip.to_string();
        if !seen.insert(address.clone()) {
            continue;
        }
        hosts.push(BindHostOption {
            address,
            kind: BindHostKind::Interface,
            interface: Some(interface),
        });
    }

    hosts
}

pub fn available_bind_hosts() -> Vec<BindHostOption> {
    match list_afinet_netifas() {
        Ok(ifaces) => collect_bind_hosts_from_iter(ifaces),
        Err(_) => collect_bind_hosts_from_iter(std::iter::empty()),
    }
}

/// True when `host` can still be bound right now — wildcard / loopback are
/// always OK, otherwise the address must be present on a current network
/// interface. Pass `hosts` so callers that already enumerated don't pay twice.
pub fn host_in_list(host: &str, hosts: &[BindHostOption]) -> bool {
    let h = host.trim();
    if matches!(
        h,
        "" | "0.0.0.0" | "::" | "[::]" | "127.0.0.1" | "::1" | "[::1]"
    ) {
        return true;
    }
    let bare = h.trim_start_matches('[').trim_end_matches(']');
    hosts
        .iter()
        .any(|opt| opt.address == h || opt.address == bare)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn bind_hosts_always_start_with_local_and_all_interfaces() {
        let hosts = collect_bind_hosts_from_iter(std::iter::empty());
        assert_eq!(
            hosts,
            vec![
                BindHostOption::localhost(),
                BindHostOption::all_interfaces()
            ]
        );
    }

    #[test]
    fn host_in_list_passes_wildcard_and_loopback() {
        let hosts = collect_bind_hosts_from_iter(std::iter::empty());
        assert!(host_in_list("0.0.0.0", &hosts));
        assert!(host_in_list("::", &hosts));
        assert!(host_in_list("127.0.0.1", &hosts));
        assert!(host_in_list("::1", &hosts));
        assert!(!host_in_list("192.168.1.20", &hosts));
    }

    #[test]
    fn host_in_list_matches_specific_interface_address() {
        let hosts = collect_bind_hosts_from_iter([(
            "en0".to_string(),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
        )]);
        assert!(host_in_list("192.168.1.20", &hosts));
        assert!(!host_in_list("192.168.99.99", &hosts));
    }

    #[test]
    fn bind_hosts_filter_non_bindable_ipv4_and_dedupe_results() {
        let hosts = collect_bind_hosts_from_iter([
            ("lo0".to_string(), IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
            (
                "en0".to_string(),
                IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
            ),
            (
                "en1".to_string(),
                IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
            ),
            (
                "en2".to_string(),
                IpAddr::V4(Ipv4Addr::new(169, 254, 10, 20)),
            ),
            ("awdl0".to_string(), IpAddr::V6(Ipv6Addr::LOCALHOST)),
            ("bridge0".to_string(), IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0))),
        ]);

        assert_eq!(
            hosts,
            vec![
                BindHostOption::localhost(),
                BindHostOption::all_interfaces(),
                BindHostOption {
                    address: "192.168.1.20".to_string(),
                    kind: BindHostKind::Interface,
                    interface: Some("en0".to_string()),
                },
            ]
        );
    }
}
