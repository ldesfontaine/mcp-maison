// Les réponses de l'API REST d'openCloud (branche dev), réduites aux champs que les outils lisent.
// Source : internal/server/api_*.go (structures *JSON). Les instants sont des chaînes RFC 3339, null si absents.

type Time = string | null;

export interface Session { version: string } // + langue et seuils du front, non lus
export type Counts = Record<string, unknown>; // rendu tel quel : des compteurs (api_session.go, countsResponse)

export interface Machine {
  id: string; name: string; hostname: string; address: string; os: string; arch: string; online: boolean;
  last_seen_at: Time;
  agent: { version: string; revoked_at: Time; capabilities: { name: string }[]; capabilities_differ: boolean } | null;
  lifecycle?: { status: string; product: string; cycle: string; eol_from: string };
}
export interface Machines { machines: Machine[] } // + pending (jetons d'enrôlement), non lu

export interface Finding { kind: string; level: string; port?: number; protocol?: string }
export interface Container {
  id: string; machine_name: string; name: string; group: string; image: string; state: string; exit_code: number;
  oom_killed: boolean; health: string; restart_count: number; compose_service: string; update_policy: string;
  image_check: { kind: string; newer_tag: string; target: string } | null;
  ports: { ip: string; host_port: number; container_port: number; protocol: string }[];
  networks: { name: string }[]; depends_on: { name: string }[]; exposure: Finding[];
  started_at: Time; finished_at: Time; current: Record<string, unknown> | null;
}
export interface Engine { present: boolean; reason: string; version: string }
export interface Containers { containers: Container[] }
export interface ContainerDetail {
  container: Container; engine: Engine | null;
  directory: { declared: boolean; service_name: string; unit_name: string } | null;
  transitions: { at: string; action: string; new_state: string; new_health: string; exit_code: number | null }[];
}
export interface LogLine { at: Time; stream: string; text: string }
export interface Logs { lines: LogLine[] }

export interface Network {
  machine_name: string; online: boolean; engine: Engine | null; containers: Container[];
  groups: { name: string; internal: boolean; members: string[] }[];
  edges: { from: string; to: string; kind: string; port?: number; protocol?: string }[];
}

export interface Service {
  id: string; machine_name: string; name: string; title: string; nature: string; compose_project: string;
  public_url: string;
  units: { name: string; kind: string; image: string; version: string; container_name: string; systemd_unit: string }[];
}
export interface Services { services: Service[] }
export interface Gaps { // écart entre l'annuaire et ce que les machines montrent (api_directory_gaps.go)
  services: {
    service_id: string; state: string; weak: boolean; // state : conform, absent, diverged, unverifiable, unobserved
    units: {
      name: string; kind: string; state: string; weak: boolean;
      containers: { name: string; state: string; image: string; verdict: string; reason: string }[];
    }[];
  }[];
  undeclared: {
    machine_name: string; key_kind: string; key_value: string; ignored: boolean; adoptable: boolean;
    containers: { name: string; state: string; image: string; label_problem: string }[];
  }[];
}

export interface Job {
  id: string; name: string; machine_name: string; status: string; interval_seconds: number; grace_seconds: number;
  last_ping_at: Time; next_deadline_at: Time; last_exit_code: number | null; last_duration_ms: number | null;
}
export interface Jobs { jobs: Job[] }
export interface JobDetail { // + ping_url, snippets (le jeton de la tâche) : jamais lus
  job: Job;
  runs: { started_at: Time; duration_ms: number | null; exit_code: number | null; outcome: string }[];
  pings: { kind: string; received_at: string; exit_code: number | null }[];
}

export interface Probe {
  id: string; name: string; kind: string; target: string; machine_name: string; machine_online: boolean;
  service_name: string; status: string; last_checked_at: Time; last_code: number | null; last_reason: string;
  last_duration_ms: number;
  certificate: { not_after: string; chain_valid: boolean; hostname_match: boolean } & Record<string, unknown> | null;
}
export interface ProbeDay { total: number; success: number }
export interface Probes { probes: Probe[]; days: Record<string, ProbeDay[]> }
export interface ProbeDetail {
  probe: Probe; uptime: { window: string; total: number; success: number }[];
  results: { checked_at: string; outcome: string; duration_ms: number; code: number | null; reason: string }[];
}

export interface StatusPage { id: string; slug: string; title: string; announcement: string; public_url: string }
export interface StatusPages { pages: StatusPage[] }
export interface Components {
  global: string;
  components: { name: string; effective: string; members: { kind: string; name: string; state: string }[] }[];
}
export interface Incident {
  id: string; title: string; impact: string; status: string; starts_at: Time; ends_at: Time; resolved_at: Time;
  targets: { kind: string; id: string; name: string }[]; // kind : machine, service, job, probe
  components: { name: string }[]; // ceux que les cibles touchent ; peut être vide
  updates: { status: string; message: string; created_at: string }[];
}
export interface Incidents { incidents: Incident[] }

export interface Alert {
  id: number; kind: string; severity: string; status: string; muted: boolean;
  object: { kind: string; id: string; name: string }; machine_name: string;
  details: Record<string, unknown> & { target?: string };
  opened_at: string; acknowledged_at: Time; resolved_at: Time;
}
export interface Alerts { alerts: Alert[]; counts: { open: number; unacknowledged: number } }
export interface AlertDetail {
  alert: Alert;
  deliveries: { channel_id: number; event: string; status: string; attempts: number; reason: string; code: number }[];
}
export interface Channels { // + destination (adresses), non lue
  channels: {
    id: number; name: string; format: string; url: string; min_severity: string; notify_resolve: boolean;
    enabled: boolean; plain: boolean;
  }[];
}

export interface Audit {
  events: {
    id: number; at: string; actor_kind: string; actor_name: string; action: string; object_kind: string;
    object_id: string; object_name: string; details: Record<string, string>;
  }[];
  next_before: number | null;
}

export interface Actions {
  runs: {
    id: string; kind: string; machine_name: string; state: string; reason: string; requested_by: string;
    requested_at: string; finished_at: Time; params: unknown; output: { line: string }[];
  }[];
}

// GET /api/machines/{id}/proxmox (api_proxmox.go) ; non lus : token_id, pin, api_url, verified_at.
export interface Proxmox {
  node: string; version: string; last_read_at: Time; last_error: string;
  guests: {
    vmid: number; kind: string; name: string; status: string; template: boolean; node: string; cpus: number;
    max_memory: number; max_disk: number; linked_machine_id: string | null; last_backup_at: Time;
    last_backup_bytes: number;
  }[];
  storages: {
    node: string; name: string; type: string; total: number; used: number; avail: number; content: string[];
    active: boolean;
  }[];
}

// api_firewalls.go. Non lus : api_url, api_key et pin (un jeton d'API ne les voit pas), is_pinned, verified_at.
export interface Firewall {
  id: string; name: string; kind: string; version: string; last_read_at: Time; last_error: string;
  counts: { interfaces: number; rules: number; leases: number; gateways: number };
}
export interface Firewalls { firewalls: Firewall[] } // + limit, non lu
export interface FirewallDetail extends Firewall {
  gateways: { name: string; address: string; status: string; delay_ms: number | null; loss_percent: number | null }[];
}
interface FirewallReading { id: string; name: string; last_read_at: Time; last_error: string }
export interface FirewallRules extends FirewallReading {
  rules: {
    interface: string; action: string; direction: string; protocol: string; source: string; source_port: string;
    destination: string; destination_port: string; description: string; is_enabled: boolean;
  }[];
}
export interface FirewallInterfaces extends FirewallReading {
  interfaces: { name: string; device: string; role: string; address: string; status: string }[];
}
export interface FirewallLeases extends FirewallReading {
  leases: {
    address: string; mac: string; hostname: string; interface: string; server: string; is_static: boolean;
    expires_at: Time;
  }[];
}
