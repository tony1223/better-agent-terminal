use get_if_addrs::{get_if_addrs, IfAddr};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NetworkAddress {
    pub ip: String,
    pub mode: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InterfaceAddress {
    name: String,
    ip: String,
}

pub fn bound_host_for_interface(bind_interface: &str) -> String {
    match bind_interface {
        "all" => "0.0.0.0".to_string(),
        "tailscale" => first_tailscale_ip().unwrap_or_else(|| "127.0.0.1".to_string()),
        _ => "127.0.0.1".to_string(),
    }
}

pub fn all_addresses(bound_host: &str) -> Vec<NetworkAddress> {
    match bound_host {
        "127.0.0.1" | "::1" | "localhost" => return vec![loopback_address()],
        "0.0.0.0" | "::" => {}
        host => return vec![address_for_host(host)],
    }

    let mut tailscale = Vec::new();
    let mut lan = Vec::new();
    for iface in interface_addresses() {
        if is_tailscale_ip(&iface.ip) {
            tailscale.push(NetworkAddress {
                ip: iface.ip.clone(),
                mode: "tailscale".to_string(),
                label: format!("{} - {} (Tailscale)", iface.name, iface.ip),
            });
        } else {
            lan.push(NetworkAddress {
                ip: iface.ip.clone(),
                mode: "lan".to_string(),
                label: format!("{} - {} (LAN)", iface.name, iface.ip),
            });
        }
    }
    tailscale.extend(lan);
    tailscale
}

fn first_tailscale_ip() -> Option<String> {
    interface_addresses()
        .into_iter()
        .find(|iface| is_tailscale_ip(&iface.ip))
        .map(|iface| iface.ip)
}

fn interface_addresses() -> Vec<InterfaceAddress> {
    let Ok(ifaces) = get_if_addrs() else {
        return Vec::new();
    };
    ifaces
        .into_iter()
        .filter(|iface| !iface.is_loopback())
        .filter_map(|iface| match iface.addr {
            IfAddr::V4(addr) => Some(InterfaceAddress {
                name: iface.name,
                ip: addr.ip.to_string(),
            }),
            IfAddr::V6(_) => None,
        })
        .collect()
}

fn address_for_host(host: &str) -> NetworkAddress {
    let mode = if is_tailscale_ip(host) {
        "tailscale"
    } else {
        "lan"
    };
    let label = if mode == "tailscale" {
        format!("{host} (Tailscale)")
    } else {
        host.to_string()
    };
    NetworkAddress {
        ip: host.to_string(),
        mode: mode.to_string(),
        label,
    }
}

fn loopback_address() -> NetworkAddress {
    NetworkAddress {
        ip: "127.0.0.1".to_string(),
        mode: "localhost".to_string(),
        label: "localhost - 127.0.0.1".to_string(),
    }
}

fn is_tailscale_ip(ip: &str) -> bool {
    ip.starts_with("100.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_bound_host_only_advertises_loopback() {
        assert_eq!(
            all_addresses("127.0.0.1"),
            vec![NetworkAddress {
                ip: "127.0.0.1".into(),
                mode: "localhost".into(),
                label: "localhost - 127.0.0.1".into(),
            }]
        );
    }

    #[test]
    fn concrete_tailscale_host_is_marked_tailscale() {
        assert_eq!(all_addresses("100.64.0.1")[0].mode, "tailscale");
    }
}
