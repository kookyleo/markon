use local_ip_address::list_afinet_netifas;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::CString;
use std::net::{IpAddr, Ipv6Addr, SocketAddr, SocketAddrV6};
use std::os::raw::{c_char, c_uint};

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

    fn localhost_v6() -> Self {
        Self {
            address: "::1".to_string(),
            kind: BindHostKind::Localhost,
            interface: None,
        }
    }

    fn all_interfaces_v6() -> Self {
        Self {
            address: "::".to_string(),
            kind: BindHostKind::AllInterfaces,
            interface: None,
        }
    }
}

fn is_bindable_ipv4(ip: &std::net::Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified()
}

fn is_bindable_ipv6(ip: &Ipv6Addr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast()
}

fn interface_scope_id(interface: &str) -> Option<u32> {
    interface
        .parse::<u32>()
        .ok()
        .or_else(|| interface_name_to_index(interface))
}

#[cfg(unix)]
fn interface_name_to_index(interface: &str) -> Option<u32> {
    extern "C" {
        fn if_nametoindex(ifname: *const c_char) -> c_uint;
    }

    let name = CString::new(interface).ok()?;
    let idx = unsafe { if_nametoindex(name.as_ptr()) };
    (idx != 0).then_some(idx)
}

#[cfg(not(unix))]
fn interface_name_to_index(_interface: &str) -> Option<u32> {
    None
}

fn bindable_interface_address(interface: &str, ip: &IpAddr) -> Option<String> {
    match ip {
        IpAddr::V4(ipv4) if is_bindable_ipv4(ipv4) => Some(ipv4.to_string()),
        IpAddr::V6(ipv6) if is_bindable_ipv6(ipv6) => {
            if ipv6.is_unicast_link_local() {
                interface_scope_id(interface).map(|scope| format!("{ipv6}%{scope}"))
            } else {
                Some(ipv6.to_string())
            }
        }
        _ => None,
    }
}

fn collect_bind_hosts_from_iter<I>(ifaces: I) -> Vec<BindHostOption>
where
    I: IntoIterator<Item = (String, IpAddr)>,
{
    let mut hosts = vec![
        BindHostOption::localhost(),
        BindHostOption::localhost_v6(),
        BindHostOption::all_interfaces(),
        BindHostOption::all_interfaces_v6(),
    ];
    let mut seen: HashSet<String> = hosts.iter().map(|host| host.address.clone()).collect();

    for (interface, ip) in ifaces {
        let Some(address) = bindable_interface_address(&interface, &ip) else {
            continue;
        };
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

fn strip_host_brackets(host: &str) -> &str {
    let h = host.trim();
    h.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(h)
}

fn parse_ipv6_with_scope(host: &str) -> Option<(Ipv6Addr, u32)> {
    let (addr, scope) = strip_host_brackets(host).rsplit_once('%')?;
    let addr = addr.parse::<Ipv6Addr>().ok()?;
    let scope = interface_scope_id(scope)?;
    Some((addr, scope))
}

pub fn host_ip(host: &str) -> Option<IpAddr> {
    let h = strip_host_brackets(host);
    if let Some((addr, _)) = parse_ipv6_with_scope(h) {
        return Some(IpAddr::V6(addr));
    }
    h.parse::<IpAddr>().ok()
}

pub fn host_is_ipv4(host: &str) -> bool {
    matches!(host_ip(host), Some(IpAddr::V4(_)))
}

pub fn host_is_ipv6(host: &str) -> bool {
    matches!(host_ip(host), Some(IpAddr::V6(_)))
}

pub fn host_is_wildcard_v4(host: &str) -> bool {
    matches!(strip_host_brackets(host), "" | "0.0.0.0")
}

pub fn host_is_wildcard_v6(host: &str) -> bool {
    matches!(strip_host_brackets(host), "::")
}

pub fn host_is_wildcard(host: &str) -> bool {
    host_is_wildcard_v4(host) || host_is_wildcard_v6(host)
}

pub fn host_is_loopback(host: &str) -> bool {
    matches!(host_ip(host), Some(ip) if ip.is_loopback())
}

fn canonical_host_for_compare(host: &str) -> String {
    let h = strip_host_brackets(host);
    if let Some((addr, scope)) = parse_ipv6_with_scope(h) {
        return format!("{addr}%{scope}");
    }
    match h.parse::<IpAddr>() {
        Ok(ip) => ip.to_string(),
        Err(_) => h.to_string(),
    }
}

pub fn host_matches(a: &str, b: &str) -> bool {
    canonical_host_for_compare(a) == canonical_host_for_compare(b)
}

/// Bracket a bare IPv6 literal for use in an HTTP URL. Scoped IPv6 literals
/// use RFC 6874 escaping (`%25`) so link-local URLs stay syntactically valid.
pub fn url_host_literal(host: &str) -> String {
    let h = strip_host_brackets(host);
    if let Some((addr, scope)) = parse_ipv6_with_scope(h) {
        return format!("[{addr}%25{scope}]");
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V6(addr)) => format!("[{addr}]"),
        _ => h.to_string(),
    }
}

pub fn bind_socket_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    let h = strip_host_brackets(host);
    let h = if h.is_empty() { "0.0.0.0" } else { h };
    if let Some((addr, scope)) = parse_ipv6_with_scope(h) {
        return Ok(SocketAddr::V6(SocketAddrV6::new(addr, port, 0, scope)));
    }
    h.parse::<IpAddr>()
        .map(|ip| SocketAddr::new(ip, port))
        .map_err(|e| format!("Invalid host address '{}': {}", host, e))
}

/// True when `host` can still be bound right now — wildcard / loopback are
/// always OK, otherwise the address must be present on a current network
/// interface. Pass `hosts` so callers that already enumerated don't pay twice.
pub fn host_in_list(host: &str, hosts: &[BindHostOption]) -> bool {
    let h = host.trim();
    if host_is_wildcard(h) || host_is_loopback(h) {
        return true;
    }
    hosts.iter().any(|opt| host_matches(&opt.address, h))
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
                BindHostOption::localhost_v6(),
                BindHostOption::all_interfaces(),
                BindHostOption::all_interfaces_v6()
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
        let hosts = collect_bind_hosts_from_iter([
            (
                "en0".to_string(),
                IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
            ),
            (
                "en0".to_string(),
                IpAddr::V6("fd00::20".parse::<Ipv6Addr>().unwrap()),
            ),
        ]);
        assert!(host_in_list("192.168.1.20", &hosts));
        assert!(host_in_list("fd00::20", &hosts));
        assert!(host_in_list("[fd00::20]", &hosts));
        assert!(!host_in_list("192.168.99.99", &hosts));
        assert!(!host_in_list("fd00::99", &hosts));
    }

    #[test]
    fn bind_hosts_filter_non_bindable_ips_and_dedupe_results() {
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
            (
                "en0".to_string(),
                IpAddr::V6("fd00::20".parse::<Ipv6Addr>().unwrap()),
            ),
            (
                "en1".to_string(),
                IpAddr::V6("fd00::20".parse::<Ipv6Addr>().unwrap()),
            ),
            ("utun0".to_string(), IpAddr::V6(Ipv6Addr::UNSPECIFIED)),
            (
                "utun1".to_string(),
                IpAddr::V6("ff02::1".parse::<Ipv6Addr>().unwrap()),
            ),
            ("bridge0".to_string(), IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0))),
        ]);

        assert_eq!(
            hosts,
            vec![
                BindHostOption::localhost(),
                BindHostOption::localhost_v6(),
                BindHostOption::all_interfaces(),
                BindHostOption::all_interfaces_v6(),
                BindHostOption {
                    address: "192.168.1.20".to_string(),
                    kind: BindHostKind::Interface,
                    interface: Some("en0".to_string()),
                },
                BindHostOption {
                    address: "fd00::20".to_string(),
                    kind: BindHostKind::Interface,
                    interface: Some("en0".to_string()),
                },
            ]
        );
    }

    #[test]
    fn url_host_literal_brackets_ipv6_and_escapes_scope() {
        assert_eq!(url_host_literal("127.0.0.1"), "127.0.0.1");
        assert_eq!(url_host_literal("::1"), "[::1]");
        assert_eq!(url_host_literal("[::1]"), "[::1]");
        assert_eq!(url_host_literal("fe80::1%4"), "[fe80::1%254]");
    }

    #[test]
    fn bind_socket_addr_accepts_ipv4_and_ipv6_literals() {
        assert_eq!(
            bind_socket_addr("127.0.0.1", 6419).unwrap().to_string(),
            "127.0.0.1:6419"
        );
        assert_eq!(
            bind_socket_addr("::1", 6419).unwrap().to_string(),
            "[::1]:6419"
        );
        assert_eq!(
            bind_socket_addr("[::1]", 6419).unwrap().to_string(),
            "[::1]:6419"
        );
        assert_eq!(
            bind_socket_addr("fe80::1%4", 6419).unwrap().to_string(),
            "[fe80::1%4]:6419"
        );
    }
}
