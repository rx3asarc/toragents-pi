#!/usr/bin/env python3
"""inbox_agent.py -- a verified message inbox behind a tor hidden service.

Runs on HER machine. Listens on a plain localhost TCP port; tor forwards the
hidden service to it. Serving needs no tor API at all -- no control port, no
ADD_ONION, no keys to manage. Only outbound sends touch tor, via SOCKS.

Security model
    A message is accepted only if the sender proves possession of an
    allowlisted Ed25519 key over a one-use nonce. The sender's claimed onion
    address is never trusted for routing.

Usage
    inbox_agent.py serve                 run the daemon
    inbox_agent.py whoami                print this machine's onion + fingerprint
    inbox_agent.py add-peer FP --onion A allow a peer to send
    inbox_agent.py peers
    inbox_agent.py inbox
    inbox_agent.py read <id>
    inbox_agent.py ack <id>
    inbox_agent.py send --to LABEL --body TEXT
"""
import argparse
import base64
import binascii
import hashlib
import json
from pathlib import Path
import os
import re
import secrets
import shutil
import subprocess
import socket
import sys
import threading
import time
import uuid

from wire import AgentKeys, PublicIdentity

HOME = os.environ.get("TORAGENTS_HOME", os.path.expanduser("~/.toragents"))
# TORAGENTS_STATE wins over $HOME/state so this CLI can operate on a flat state
# directory (the layout listener.py uses on the box). Without it the two tools
# disagree about where identity.json lives, and whoami silently mints a
# throwaway key and signs with the wrong one.
STATE = os.environ.get("TORAGENTS_STATE") or os.path.join(HOME, "state")
INBOX = os.path.join(STATE, "inbox")
SENT = os.path.join(STATE, "sent")
ARCHIVE = os.path.join(STATE, "archive")
PEERS = os.path.join(STATE, "peers.json")
IDFILE = os.path.join(STATE, "identity.json")
HOSTNAME_FILE = os.path.join(HOME, "hs", "hostname")

CONFIG = os.path.join(STATE, "config.json")


def _installed_config():
    """Read the ports the installer actually configured.

    This exists because the CLI and the daemon must agree on the SOCKS port and
    the daemon is the only one that gets TORAGENTS_SOCKS from its service unit.
    The old fallback was 9050 while the installer writes 9061, so every bare
    `send`/`inbox` died with "Connection refused" until the user exported the
    variable by hand. Env still wins; the recorded config is the fallback.
    """
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


_cfg = _installed_config()
LISTEN_PORT = int(os.environ.get("TORAGENTS_PORT") or _cfg.get("local_port") or 8799)
SOCKS_PORT = int(os.environ.get("TORAGENTS_SOCKS") or _cfg.get("socks_port") or 9050)
NONCE_TTL = 180.0

b64e = lambda b: base64.b64encode(b).decode("ascii")
b64d = lambda s: base64.b64decode(s)


# ---------------------------------------------------------------- state ---
def dirs():
    for d in (STATE, INBOX, ARCHIVE):
        os.makedirs(d, exist_ok=True)


def keys(create=False):
    """Load the identity. Returns None if absent and create is False.

    Minting is opt-in on purpose. A read-only command that creates an identity
    is a footgun: it writes a new key, and anything that then signs with it is
    silently using the wrong identity, which the peer rejects in a way that
    looks like a network fault.
    """
    dirs()
    if os.path.exists(IDFILE):
        with open(IDFILE) as f:
            return AgentKeys.from_secret_dict(json.load(f))
    if not create:
        return None
    k = AgentKeys.generate()
    fd = os.open(IDFILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(k.to_secret_dict(), f)
    return k


def need_keys():
    k = keys()
    if k is None:
        print(f"no identity at {IDFILE}", file=sys.stderr)
        print("  create one with:  inbox_agent.py init", file=sys.stderr)
        print("  (the installer does this for you; whoami never writes)",
              file=sys.stderr)
        raise SystemExit(2)
    return k


# Retry-on-failure keeps the peers we already have. That is right for a
# TRANSIENT fault, and wrong for a DELIBERATE one: if an operator revokes a
# compromised peer by rewriting peers.json and the result is unreadable or
# invalid, keeping stale peers would leave the revoked key allowlisted. So the
# two failure classes are treated differently:
#
#   absent      -> {}           nothing configured yet
#   unreadable  -> KEEP + retry I/O error: permissions, fd limit, unsynced file
#   corrupt     -> FAIL CLOSED  readable but not a valid allowlist: do not trust it
#
# save_peers() writes tmp+os.replace, so our own writes can never truncate the
# file; "corrupt" means someone edited it by hand or the disk lost a block.
PEERS_ABSENT = "absent"
PEERS_OK = "ok"
PEERS_UNREADABLE = "unreadable"
PEERS_CORRUPT = "corrupt"


def peers_state():
    """(status, mapping) — see the table above. Never raises."""
    if not os.path.exists(PEERS):
        return PEERS_ABSENT, {}
    try:
        with open(PEERS) as f:
            raw = f.read()
    except OSError:
        return PEERS_UNREADABLE, None
    try:
        data = json.loads(raw)
    except ValueError:
        return PEERS_CORRUPT, None
    if not isinstance(data, dict):
        return PEERS_CORRUPT, None
    return PEERS_OK, data


def peers():
    """Just the mapping; {} when absent or unusable. For read-only commands."""
    return peers_state()[1] or {}


def save_peers(p):
    dirs()
    tmp = PEERS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(p, f, indent=2, sort_keys=True)
    os.replace(tmp, PEERS)


def _self_fingerprint():
    """Short sha256 of the file that is actually executing.

    The box once ran a daemon no user ran, which is exactly how two shipped bugs
    stayed invisible. This makes "which code is live" answerable from the log.
    """
    try:
        with open(os.path.abspath(__file__), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:12]
    except OSError:
        return "unknown"


def onion():
    """Resolve our onion address without ever talking to tor.

    Two layouts exist:
      - static HiddenServiceDir (every install this script makes): tor writes
        $HOME/hs/hostname, which wins.
      - ADD_ONION (a daemon that registers through the control port): tor keeps
        no hostname file, so that daemon records the address it got in
        $STATE/onion.txt.

    This must stay read-only and work with tor stopped: during a cutover this
    is the evidence an operator reads, and "onion (not configured)" on a
    healthy migration would invite a false rollback.
    """
    for path in (HOSTNAME_FILE, os.path.join(STATE, "onion.txt")):
        try:
            with open(path) as f:
                val = f.read().strip()
            if val:
                return val
        except OSError:
            continue
    return None


# --------------------------------------------------------------- framing --
def send_msg(sock, obj):
    data = json.dumps(obj).encode()
    sock.sendall(len(data).to_bytes(4, "big") + data)


AGENT_VERSION = "2"
MAX_FRAME = 16 * 1024 * 1024  # same ceiling toragents uses; stops a hostile header


def recv_msg(sock):
    hdr = _read_exact(sock, 4)
    if hdr is None:
        return None
    n = int.from_bytes(hdr, "big")
    if n > MAX_FRAME:
        raise ValueError(f"declared frame {n} exceeds {MAX_FRAME}")
    body = _read_exact(sock, n)
    if body is None:
        return None
    return json.loads(body.decode())


def _read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


# ---------------------------------------------------------------- nonces --
class Nonces:
    def __init__(self):
        self._d, self._lock = {}, threading.Lock()

    def issue(self):
        n = secrets.token_bytes(32)
        with self._lock:
            now = time.time()
            self._d = {k: v for k, v in self._d.items() if v > now}
            self._d[b64e(n)] = now + NONCE_TTL
        return n

    def consume(self, token):
        with self._lock:
            exp = self._d.pop(token, None)
        if exp is None or exp < time.time():
            return None
        try:
            return b64d(token)
        except (ValueError, TypeError, binascii.Error):
            return None


# ---------------------------------------------------------------- server --
class Inbox:
    def __init__(self):
        self.k = keys(create=True)   # a daemon coming up is allowed to mint
        self.nonces = Nonces()
        status, loaded = peers_state()
        self.peers = loaded if loaded is not None else {}
        self._peers_warned = None
        self.lock = threading.Lock()
        self.accepted = self.rejected = 0
        self.addr = onion()
        self.state_dir = STATE
        self._peers_mtime = self._mtime()

    def _mtime(self):
        try:
            return os.path.getmtime(PEERS)
        except OSError:
            return None

    def _reload_peers_if_changed(self):
        """Pick up `add-peer` without restarting the daemon.

        On an unreadable file this KEEPS the peers already loaded and does not
        advance the stamp, so the read is retried on the next message instead of
        pinning an empty allowlist until the file next changes.
        """
        now = self._mtime()
        if now == self._peers_mtime:
            return
        status, loaded = peers_state()
        if status == PEERS_UNREADABLE:
            if now != self._peers_warned:
                print(f"[inbox] peers.json unreadable; keeping "
                      f"{len(self.peers)} allowed peer(s), will retry", flush=True)
                self._peers_warned = now
            return
        if status == PEERS_CORRUPT:
            # Readable but invalid: fail closed rather than trust stale peers,
            # because this is also what a botched revocation looks like.
            self.peers = {}
            self._peers_mtime = now
            self._peers_warned = None
            print(f"[inbox] peers.json is CORRUPT; failing closed with 0 allowed "
                  f"peer(s) until it is fixed: {PEERS}", flush=True)
            return
        # No lock here on purpose: the caller already holds self.lock and
        # threading.Lock is not reentrant. Assigning the dict reference is
        # atomic, and a reader that grabbed the old dict iterates a stable
        # snapshot, so a swap mid-read is safe.
        self.peers = loaded
        self._peers_mtime = now
        self._peers_warned = None
        print(f"[inbox] peer list reloaded ({len(self.peers)} allowed)", flush=True)

    def handle(self, req):
        op = req.get("op")
        if op == "ping":
            return {"ok": True, "service": "toragents-inbox", "onion": self.addr,
                    "fingerprint": self.k.public().fingerprint,
                    "version": AGENT_VERSION}
        if op == "hello":
            return {"ok": True, "nonce": b64e(self.nonces.issue())}
        if op == "send":
            return self._accept(req)
        if op == "digest":
            return self._accept_digest(req)
        return {"ok": False, "error": f"unknown op {op!r}"}

    def _verify_digest(self, req):
        """Shared by the digest op and the piggybacked dg on a send. Returns
        (fingerprint, peer) or an error string."""
        for field in ("pubkey", "nonce", "dsig"):
            if not req.get(field):
                return None, f"digest frame is missing {field}"
        try:
            pub = PublicIdentity.from_dict(req["pubkey"])
            nonce = b64d(req["nonce"])
            dsig = b64d(req["dsig"])
        except (KeyError, ValueError, TypeError) as e:
            # Narrow on purpose: a bare `except Exception` here once turned an
            # AttributeError into "missing pubkey/nonce/dsig", which is a
            # confident and completely wrong statement about the caller's frame.
            return None, f"malformed digest frame: {e.__class__.__name__}: {e}"
        dg = req.get("dg")
        ok, why = dg_validate(dg)
        if not ok:
            return None, why
        from nacl.exceptions import BadSignatureError
        try:
            if not pub.verify(nonce + b"toragents-dg1" + dg_canon(dg), dsig):
                return None, "digest signature does not verify"
        except BadSignatureError:
            return None, "digest signature does not verify"
        except Exception as e:
            # A broken verify() is OUR defect. Telling the peer their signature is
            # bad would send them hunting in the wrong machine.
            return None, f"digest verification error: {e.__class__.__name__}: {e}"
        fp = pub.fingerprint
        with self.lock:
            peer = self.peers.get(fp)
        if peer is None:
            return None, "sender not on allowlist"
        return (fp, peer), None

    def _accept_digest(self, req):
        # Refuse unauthenticated or oversized frames BEFORE spending the nonce:
        # otherwise anyone can force a hello and burn a peer's one-use token with
        # garbage, which is a free denial of service on the whole channel.
        raw_dg = req.get("dg")
        try:
            size = len(dg_canon(raw_dg))
        except Exception:
            size = 0
        if size > DG_MAX_BYTES:
            self.rejected += 1
            return {"ok": False, "error": f"dg exceeds the {DG_MAX_BYTES}-byte limit ({size} bytes)"}
        got, err = self._verify_digest(req)
        if err:
            self.rejected += 1
            return {"ok": False, "error": err}
        if self.nonces.consume(req.get("nonce")) is None:
            return {"ok": False, "error": "stale or unknown nonce"}
        fp, peer = got
        res = dg_apply(self.state_dir, fp, req["dg"])
        print(f"[inbox] dg from {peer.get('label') or fp[:12]}: "
              f"{'accepted' if res.get('ok') else res.get('error')}", flush=True)
        return {"ok": bool(res.get("ok")), "error": res.get("error", ""),
                "applied": len(res.get("rows") or {})}

    def _accept(self, req):
        # Wire sanity before any parsing or auth: a frame above the cap is refused
        # outright and nothing is stored. This is the only path that can actually
        # hit DG_MAX_BYTES -- schema-valid digests are ~939 bytes under it.
        raw_dg = req.get("dg")
        if raw_dg is not None:
            try:
                size = len(dg_canon(raw_dg))
            except Exception:
                size = 0
            if size > DG_MAX_BYTES:
                self.rejected += 1
                return {"ok": False,
                        "error": f"dg exceeds the {DG_MAX_BYTES}-byte limit ({size} bytes)"}
        token, body, pub, sig = (req.get("nonce"), req.get("body"),
                                 req.get("pubkey"), req.get("sig"))
        if not all([token, isinstance(body, str), pub, sig]):
            self.rejected += 1
            return {"ok": False, "error": "malformed send"}

        nonce = self.nonces.consume(token)
        if nonce is None:
            self.rejected += 1
            return {"ok": False, "error": "stale or unknown nonce"}

        try:
            sender = PublicIdentity.from_dict(pub)
            signature = b64d(sig)
        except (KeyError, ValueError, TypeError, binascii.Error) as e:
            # Narrow: a crash in OUR decoder must not be reported to the peer as
            # THEIR encoding being bad. Every peer message travels through here,
            # so a confident wrong sentence at this line is the widest-blast-radius
            # version of the same bug we have now shipped four times.
            self.rejected += 1
            return {"ok": False, "error": f"bad pubkey or signature encoding ({e.__class__.__name__})"}

        if not sender.verify(nonce + body.encode("utf-8"), signature):
            self.rejected += 1
            return {"ok": False, "error": "signature does not verify"}

        fp = sender.fingerprint
        self._reload_peers_if_changed()
        with self.lock:
            peer = self.peers.get(fp)
        if peer is None:
            self.rejected += 1
            return {"ok": False, "error": "sender not on allowlist",
                    "fingerprint": fp}

        # A message addressed to a window must not be silently consumed by
        # whichever window happens to be open. Refuse and say the label, so the
        # sender's receipt reports a fact instead of a cheerful "sent".
        target_session = (req.get("to_session") or "").strip()
        presence = ""
        if target_session:
            live = live_labels(self.state_dir)
            if not live.get(target_session):
                trust = writer_state(self.state_dir)
                if trust != "trusted":
                    # Degrade ADDRESSING, never delivery. We cannot tell "no window
                    # here" from "nobody wrote the registry", so the message is
                    # stored and the owner delivers it, with the reason on the
                    # receipt. Refusing here would make an old peer unreachable for
                    # exactly the mail a sender bothered to address.
                    presence = f"unverified: no heartbeat writer ({trust})"
                    target_session = ""
                else:
                    self.rejected += 1
                    return {"ok": False,
                        "error": f"addressed to {target_session}, no live session on this box",
                        "live_sessions": sorted(k for k, v in live.items() if v)}

        mid = uuid.uuid4().hex[:12]
        rec = {"id": mid, "received": time.time(), "from_fingerprint": fp,
               "from_label": peer.get("label", ""), "from_onion": peer.get("onion", ""),
               # Allowlisting is checked HERE and nowhere later, so it is a fact about
               # the moment of receipt. Storing it is the only way a later reader can
               # tell "removed from the allowlist since" from "we have no idea how
               # this got in" -- and those are very different questions to answer.
               "from_known": True,
               "body": body}
        for f in ("from_session", "to_session"):
            if f == "to_session" and presence:
                # Unverified address: store the fact, not the address. Keeping it
                # would let a later reader deliver to a window we could not confirm,
                # which is the mis-delivery the refusal existed to prevent.
                continue
            v = req.get(f)
            if isinstance(v, str) and v.strip():
                rec[f] = v.strip()[:64]
        if presence:
            # The receipt and the stored record both say the targeting was not
            # honoured, and why. Silently dropping the address would look like it
            # worked; dropping the message would look like it never arrived.
            rec["presence"] = presence
        path = os.path.join(INBOX, f"{time.time():.0f}-{mid}.json")
        with open(path + ".tmp", "w") as f:
            json.dump(rec, f, indent=2)
        os.replace(path + ".tmp", path)
        self.accepted += 1
        print(f"[inbox] +{mid} from {peer.get('label') or fp[:12]}", flush=True)
        # Piggybacked digest: applied AFTER the message is safe on disk, and a bad
        # one is dropped silently-ish -- it must never cost the message. Older
        # receivers never see this because they ignore the unknown envelope key.
        if "dg" in req:
            try:
                got, err = self._verify_digest(req)
                if err:
                    print(f"[inbox] dg dropped: {err}", flush=True)
                else:
                    dg_apply(self.state_dir, got[0], req["dg"])
            except Exception as e:
                print(f"[inbox] dg dropped: {e}", flush=True)
        reply = {"ok": True, "id": mid}
        if presence:
            reply["presence"] = presence
        return reply


def client_loop(conn, box):
    try:
        while True:
            req = recv_msg(conn)
            if req is None:
                break
            try:
                reply = box.handle(req)
            except Exception as exc:
                reply = {"ok": False, "error": f"handler: {exc}"}
            send_msg(conn, reply)
    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def serve():
    box = Inbox()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", LISTEN_PORT))
    srv.listen(16)
    print(f"listening 127.0.0.1:{LISTEN_PORT}", flush=True)
    print(f"onion      {box.addr or '(hidden service not configured yet)'}", flush=True)
    print(f"fingerprint {box.k.public().fingerprint}", flush=True)
    print(f"peers      {len(box.peers)}", flush=True)
    try:
        while True:
            conn, _ = srv.accept()
            threading.Thread(target=client_loop, args=(conn, box), daemon=True).start()
    except KeyboardInterrupt:
        pass
    finally:
        srv.close()


# ---------------------------------------------------------------- client --
# Escalating ladder: fetching a COLD descriptor (a peer whose tor has only just
# published, i.e. every brand-new user's first message) routinely takes longer
# than a single short timeout. A flat 4x30s budget produced a spurious
# ConnectionError on first contact, then succeeded instantly on retry.
DIAL_LADDER = [int(x) for x in
               os.environ.get("TORAGENTS_DIAL_LADDER", "30,60,120,180").split(",")]


def dial(target_onion, timeout=None):
    """Plain SOCKS5 dial through the local tor. No tor API, just socks."""
    import socks
    host = target_onion[:-6] if target_onion.endswith(".onion") else target_onion
    last = None
    for i, budget in enumerate(DIAL_LADDER):
        s = socks.socksocket()
        s.set_proxy(socks.SOCKS5, "127.0.0.1", SOCKS_PORT, rdns=True)
        s.settimeout(budget)
        if i:
            print(f"  retry {i}/{len(DIAL_LADDER) - 1} "
                  f"(waiting up to {budget}s for the descriptor)",
                  file=sys.stderr)
        try:
            s.connect((host + ".onion", 80))
            return s
        except Exception as exc:
            last = exc
            try:
                s.close()
            except Exception:
                pass
    raise ConnectionError(
        f"cannot reach {target_onion[:16]}... after {len(DIAL_LADDER)} attempts: {last}\n"
        f"  MEASURED: a peer whose tor has just restarted takes about THREE MINUTES\n"
        f"  to republish its descriptor (182 s measured on this project). Every\n"
        f"  reinstall on either side restarts tor, so a fresh install is followed by\n"
        f"  three minutes in which that peer is unreachable and looks dead. Wait, do\n"
        f"  not reinstall again to 'fix' it -- that restarts the clock.\n"
        f"  Check the peer is running and tor is up on 127.0.0.1:{SOCKS_PORT}.")


def cmd_reach(a):
    """Is the peer actually reachable, right now, through OUR tor?

    This exists because two separate mistakes produced a false "the peer is
    down" in one session:

      1. dialling the peer's LOCAL port. The onion exposes ONE virtual port (80)
         which their tor forwards to their listener; their local port number is
         invisible from here and dialling it is refused.
      2. dialling through the wrong tor. If the state config has no socks_port
         the CLI falls back to 9050 -- the machine's default tor, which may not
         be the instance that carries these circuits -- and descriptor fetches
         stall there while the dedicated instance answers in seconds.

    So: dial port 80, report WHICH socks port did it, and time it.
    """
    import time
    p = peers()
    target = None
    for fp, v in p.items():
        if not a.to or a.to in (fp, v.get("label"), fp[:12]):
            target = v
            break
    if target is None:
        sys.exit(f"unknown peer {a.to!r}; try: inbox_agent.py peers")
    label = target.get("label") or target["onion"][:16]
    print(f"peer      {label}")
    print(f"onion     {target['onion']}")
    print(f"dialling  {target['onion'][:16]}...:80   via socks 127.0.0.1:{SOCKS_PORT}")
    t0 = time.time()
    try:
        s = dial(target["onion"], )
    except ConnectionError as exc:
        print(f"\n  UNREACHABLE after {time.time() - t0:.1f}s")
        print(f"  {exc}")
        if SOCKS_PORT == 9050:
            print("  note: this used tor's default SOCKS port. If this machine runs a")
            print("        dedicated tor for toragents, set socks_port in")
            print("        <state>/config.json or TORAGENTS_SOCKS, and retry.")
        sys.exit(2)
    dt = time.time() - t0
    try:
        s.close()
    except Exception:
        pass
    print(f"\n  REACHABLE in {dt:.1f}s -- their tor published, their listener accepted")


def auto_session() -> str:
    """Who is speaking, without asking anyone to configure anything.

    pi exports PI_SESSION_ID to everything it spawns, and that id is stable per
    conversation and survives --resume. So a short prefix is a name that
    identifies the session to the other machine for its whole life: no setup, no
    env var to remember, and two sessions on one box stop looking like one.
    """
    explicit = (os.environ.get("TORAGENTS_SESSION") or "").strip()
    if explicit:
        return explicit[:64]
    for var, prefix in (("PI_SESSION_ID", "pi"),):
        v = (os.environ.get(var) or "").strip()
        if v:
            return f"{prefix}-{v.replace('-', '')[:8]}"
    # No id in the environment: something other than pi is calling. There is
    # nothing left to guess from -- the hook that used to leave a note here is
    # gone with the other harnesses. Callers pass --session or set
    # TORAGENTS_SESSION; an empty name is honest and the header shows the peer.
    return ""


def send_to(target_onion, body, k=None, session=None, to_session=None,
            peer_fp=None, peer_label=None):
    k = k or need_keys()             # never sign with a freshly minted key
    sock = dial(target_onion)
    try:
        send_msg(sock, {"op": "hello"})
        hello = recv_msg(sock)
        if not hello or not hello.get("ok"):
            raise RuntimeError(f"hello refused: {hello}")
        nonce = b64d(hello["nonce"])
        payload = {"op": "send", "nonce": hello["nonce"], "body": body,
                   "pubkey": k.public().to_dict(),
                   "sig": b64e(k.sign(nonce + body.encode("utf-8")))}
        # Session names are ADVISORY labels, deliberately outside the signature:
        # the peer is authenticated by key, and which of that peer's live
        # sessions is talking is not something the signature can bind anyway.
        # Old receivers ignore these fields, so this stays compatible.
        if session:
            payload["from_session"] = session
        if to_session:
            payload["to_session"] = to_session
        # PIGGYBACK: our current digest rides every send, so provenance lands when
        # it is wanted with zero extra dials. Old receivers ignore the unknown keys
        # (the envelope is deliberately forward-compatible); a receiver that fails
        # to parse it drops the digest, never the message.
        try:
            dgp = dg_attach(STATE, peer_fp=peer_fp, peer_label=peer_label,
                            peer_onion=target_onion)
            payload["dg"] = dgp
            payload["dsig"] = b64e(k.sign(nonce + b"toragents-dg1" + dg_canon(dgp)))
        except Exception as e:
            print(f"[send] WARNING no digest attached: {e}", file=sys.stderr)
        send_msg(sock, payload)
        return recv_msg(sock)
    finally:
        try:
            sock.close()
        except Exception:
            pass


# --------------------------------------------------------- full outbound --
#
# Tier 2 says a digest is an index, not bodies -- so each side must hold its own
# outbound WHOLE, which nothing did: chat.jsonl keeps a display copy truncated at
# 2000 chars, and the peer's inbox holds THEIR copy of what we sent them. The
# result was a transcript split down the middle, each side holding the other's
# words complete and its own truncated.
#
# Records are written as INTENT before the dial and confirmed after the reply,
# because a send whose reply is lost still went out. Recording only successes
# would silently drop precisely the messages that matter most.

def _sent_dir():
    os.makedirs(SENT, exist_ok=True)
    return SENT


def _write_sent(rec):
    d = _sent_dir()
    path = os.path.join(d, rec["local_id"] + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def sent_intent(to_label, onion, body):
    """Record that we are about to send. Never raises into the send path."""
    rec = {"local_id": uuid.uuid4().hex[:12], "state": "pending",
           "at": time.time(), "to": to_label or "", "onion": onion or "",
           "len": len(body.encode("utf-8")),
           "sha256": hashlib.sha256(body.encode("utf-8")).hexdigest()[:32],
           "body": body}
    try:
        _write_sent(rec)
    except Exception as e:                      # a store failure must not eat a send
        print(f"[sent] WARNING could not record intent: {e}", file=sys.stderr)
    return rec


def sent_confirm(rec, reply):
    """Mark a pending record delivered; the peer's id becomes the shared key."""
    if not rec:
        return
    rec = dict(rec)
    # THREE verdicts, not two. "failed" used to mean both "the peer refused" and
    # "we never heard back", and those are different claims: a refusal is knowledge,
    # silence is not. Calling silence a failure lets the store assert something it
    # cannot know -- the same lie as a bare timestamp with no date.
    if reply is None:
        rec["state"] = "unknown"          # no answer: crash window, timeout, cut link
    elif reply.get("ok"):
        rec["state"] = "confirmed"
    else:
        rec["state"] = "refused"          # the peer positively said no
    rec["peer_id"] = (reply or {}).get("id")
    rec["reply"] = reply
    try:
        _write_sent(rec)
    except Exception as e:
        print(f"[sent] WARNING could not confirm: {e}", file=sys.stderr)
    return rec


def sent_records():
    d = _sent_dir()
    out, broken = [], []
    for name in sorted(os.listdir(d)):
        if not name.endswith(".json"):
            continue
        p = os.path.join(d, name)
        try:
            with open(p) as f:
                rec = json.load(f)
            # Legacy: records written before the three-verdict split say "failed",
            # which conflated a refusal with silence. We cannot recover which it
            # was after the fact, so it becomes unknown -- the claim we can still
            # defend -- and we say in the record that it was migrated.
            if rec.get("state") == "failed":
                rec["state"] = "unknown"
                rec["legacy_failed"] = True
            out.append(rec)
        except Exception as e:
            broken.append((name, str(e)))
    return out, broken


def cmd_sent(a):
    action = getattr(a, "action", "list") or "list"
    recs, broken = sent_records()
    if action == "verify":
        bad = []
        for r in recs:
            body = r.get("body", "")
            h = hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]
            if h != r.get("sha256") or len(body.encode("utf-8")) != r.get("len"):
                bad.append(r.get("local_id"))
        print(json.dumps({"v": 1, "records": len(recs), "broken": broken, "hash_mismatch": bad,
                          "pending": [r.get("local_id") for r in recs if r.get("state") == "pending"],
                          "refused": [r.get("local_id") for r in recs if r.get("state") == "refused"],
                          "unknown": [r.get("local_id") for r in recs if r.get("state") == "unknown"]},
                         indent=2))
        ok = not broken and not bad
        sys.exit(0 if ok else 1)
    if action == "show":
        for r in recs:
            if a.id in (r.get("local_id"), r.get("peer_id")):
                print(json.dumps({k: v for k, v in r.items() if k != "reply"}, indent=2))
                return
        sys.exit("no such record")
    # list
    if not recs:
        print("no outbound records (nothing stored yet)")
        return
    for r in sorted(recs, key=lambda x: x.get("at", 0)):
        when = time.strftime("%m-%d %H:%M", time.localtime(r.get("at", 0)))
        print(f"{when}  {r.get('state','?'):<9} {r.get('len',0):>6}b  "
              f"{r.get('peer_id') or r.get('local_id')}  -> {r.get('to','')}")


# ------------------------------------------------------------------- cli --

MY_SESSION = ""
RECEIVE_TARGETED = False


def _daemon_version():
    """What the RUNNING daemon says it is. Installing a file does not restart a
    process, so the file and the daemon can disagree -- and a whole class of
    'why does the new feature not work' is exactly that disagreement."""
    try:
        s = socket.create_connection(("127.0.0.1", LISTEN_PORT), timeout=3)
        try:
            send_msg(s, {"op": "ping"})
            r = recv_msg(s) or {}
        finally:
            s.close()
        return r.get("version") or "pre-version"
    except Exception as e:
        return f"unreachable ({e.__class__.__name__})"


# Labels that a HARNESS gives itself. Annotation, not authentication: nothing stops
# a real peer from calling itself "wiretest", so this may only be used to decide what
# to say in a report -- never to decide what to trust. The record's label is
# self-declared, which is exactly why the output says so out loud.
TEST_LABELS = {"wiretest", "self-test", "selftest", "harness", "experiment"}


def _is_test_label(label):
    label = (label or "").strip().lower()
    return bool(label) and (label in TEST_LABELS or label.startswith("test-"))


def _ownership_note(state_dir):
    """Flag a delivery owner that no live window claims to be.

    Ownership must be transferred by the claiming PROCESS (electConsumer), never by
    editing consumer.json: a hand-written foreign pid makes the incumbent's isConsumer()
    false, so it stops heart-beating and stops delivering, while the new pid never
    claims. The channel goes quiet with no error anywhere. This line is the only place
    that failure is visible.
    """
    p = os.path.join(state_dir, "consumer.json")
    if not os.path.exists(p):
        return ""
    try:
        with open(p) as f:
            rec = json.load(f)
    except (OSError, ValueError):
        return "ownership    consumer.json is unreadable: delivery ownership is unknown"
    live = live_labels(state_dir)
    label = str(rec.get("session") or "")
    name = str(rec.get("name") or "")
    fresh = (time.time() * 1000.0 - float(rec.get("at") or 0)) / 1000.0 < LIVE_STALE_MS / 1000.0
    known = bool((name and live.get(name)) or (label and live.get(label)))
    if known:
        return ""
    why = "stale heartbeat" if not fresh else "no live window reports that session"
    return (f"ownership    consumer.json names {name or label or rec.get('pid')} but "
            f"{why} <- delivery may be muted; ownership is claimed by the process "
            f"itself, never by editing the file")


def _mismatch_sentence(got, expected):
    """Which half has to move -- and say only that.

    `<` means the WINDOW is behind and /reload fixes it. `>` means WE are behind and no
    amount of reloading a window helps, because it is already running what the repo
    says. Equality never reaches here. Anything unparseable must not be dressed up as
    a direction, because the reader has no basis for the claim.
    """
    if got == expected:
        return ""                                     # unreachable, but not a lie if hit
    try:
        g, e = int(got), int(expected)
    except (TypeError, ValueError):
        return (f"window reports build {got!r}, which cannot be compared with ext "
                f"{expected}: cannot tell which side is behind")
    if g < e:
        return f"running a module from before ext {e}; /reload this window"
    return (f"this READER is behind: window ext {g}, reader expects {e}; "
            f"redeploy inbox_agent.py and restart the daemon -- reloading the window "
            f"cannot help, it is already newer than we are")


def _window_versions(state_dir):
    """Each live window's self-reported extension build, from what it wrote itself."""
    d = os.path.join(state_dir, "live")
    out = []
    if not os.path.isdir(d):
        return out
    now = time.time()
    for name in sorted(os.listdir(d)):
        if not name.endswith(".json") or name.startswith("_"):
            continue
        try:
            with open(os.path.join(d, name)) as f:
                rec = json.load(f)
        except (OSError, ValueError):
            continue
        pid = rec.get("pid")
        alive = False
        if isinstance(pid, int) and pid > 0:
            try:
                os.kill(pid, 0)
                alive = True
            except OSError:
                alive = False
        age = (now * 1000.0 - float(rec.get("at") or 0)) / 1000.0
        if not alive or age >= (LIVE_STALE_MS / 1000.0):
            continue                      # a dead window's build is not a claim
        code = str(rec.get("code") or "")
        if not code:
            out.append({"label": name[:-5], "code": "pre-version", "state": "stale",
                        "why": "does not report its build: a window that cannot say "
                               "which code it loaded cannot be trusted to run the new one"})
        elif code != EXPECTED_EXT_VERSION:
            # The verdict (mismatch) is one bit; the SENTENCE is what a human acts on,
            # and it used to assert a direction it never checked. A window NEWER than
            # this reader is not "before" anything -- the half that must move is us.
            # That is the direction our own workflow produces constantly: the repo and
            # the windows move forward, the daemon keeps running what it started with.
            why = _mismatch_sentence(code, EXPECTED_EXT_VERSION)
            out.append({"label": name[:-5], "code": code, "state": "stale", "why": why})
        else:
            out.append({"label": name[:-5], "code": code, "state": "ok", "why": ""})
    return out


def _inbox_artifact_report(state_dir):
    """Fingerprints in the inbox that no real sender could have produced.

    Returns (strangers, artifacts): senders not on the allowlist, and records whose
    from_fingerprint is not 32 hex characters at all. Both are reported, neither is
    removed -- a synthetic frame in a live inbox is evidence about how it got there.
    """
    import re
    hex32 = re.compile(r"^[0-9a-f]{32}$")
    known = set(peers())
    strangers, artifacts = [], []
    d = os.path.join(state_dir, "inbox")
    if not os.path.isdir(d):
        return strangers, artifacts
    for name in os.listdir(d):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, name)) as f:
                r = json.load(f)
        except (OSError, ValueError):
            continue
        fp = r.get("from_fingerprint") or ""
        mid = r.get("id") or name[:-5]
        # All-zero and uniform fingerprints are well-formed hex but cannot be a
        # sender: nacl never produces one, and a test frame named "deadbeefcafe"
        # produced exactly this shape on a live box.
        if not hex32.match(fp) or len(set(fp)) <= 1:
            label = (r.get("from_label") or "").strip()
            note = f", self-declared {label!r}" if label else ""
            artifacts.append(f"{mid}({fp[:12] or 'empty'}{note})")
        elif fp not in known:
            # Name the label so a human does not have to open the body to triage it.
            # Marked self-declared because that is all it is: the sender chose it, and
            # nothing stops a real peer from calling itself "wiretest". Annotation for
            # reporting only -- never an input to a trust decision.
            label = (r.get("from_label") or "").strip()
            note = ""
            if label:
                note = f", self-declared {label!r}"
                if _is_test_label(label):
                    note += " (test identity)"
            if r.get("from_known"):
                note += ", allowlisted at receipt (since removed)"
            else:
                note += ", no record of it ever being allowlisted"
            strangers.append(f"{mid}({fp[:12]}{note})")
    return sorted(strangers), sorted(artifacts)


def cmd_doctor(a):
    """Answer "is the receiving half wired up on THIS machine?" -- measured.

    pi has one receiving path, the extension, so there is exactly one question:
    is the extension installed in the directory THIS pi reads, and is it keeping
    up with the inbox? No harness config to parse and no hook that can fail
    silently, which is the whole reason this project is pi-only.
    """
    # ONE ACCOUNT. Every finding is an entry here first; the printed lines and the
    # exit status are both derived from it. A diagnostic that is only printed cannot
    # affect the code, and a diagnostic that cannot affect the code is a sentence the
    # machine never heard -- that gap shipped once (daemon mismatch printed, exit
    # stayed 0) and this shape makes it unrepresentable.
    findings = []                      # {"sev": "wrong"|"unknown"|"note", "text": ...}
    problems = findings                # kept: same object, older name in this function
    daemon_ver = _daemon_version()
    if daemon_ver != AGENT_VERSION:
        findings.append({"sev": "wrong", "label": "daemon", "state": "wrong",
                         "why": "stale daemon",
                         "text": f"code         file={AGENT_VERSION} daemon={daemon_ver}"
                                 f"  <- the daemon is running different code; restart it "
                                 f"or the new features will answer as if they do not exist"})
    else:
        findings.append({"sev": "note",
                         "text": f"code         file={AGENT_VERSION} daemon={daemon_ver}  ok"})

    # Per-window extension builds. A window reports the literal it was compiled
    # with, on every tick, so a stale one cannot hide and cannot lie about itself.
    windows = _window_versions(STATE)
    if windows:
        for w in windows:
            findings.append({"sev": "note" if w["state"] == "ok" else "wrong",
                             "label": w["label"], "state": w["state"], "why": w["why"],
                             "text": f"window       {w['label']:<16} ext={w['code']} "
                                     f"{w['state']}"
                                     + ("" if w["state"] == "ok" else "  <- " + w["why"])})
    else:
        # Two kinds of stale, and only one of them writes a marker. A window running
        # an extension older than markLive writes NOTHING, so it is invisible here --
        # and "no windows" would be inferred from an absence, which is the mistake
        # this codebase has now made in four subsystems. The writer marker is what
        # separates the cases: fresh marker + no windows = genuinely none; no marker
        # = we cannot answer, and a window may be open in front of a human.
        trust = writer_state(STATE)
        if trust == "trusted":
            findings.append({"sev": "note",
                             "text": f"window       (no live window has reported its "
                                     f"build; expected ext={EXPECTED_EXT_VERSION})"})
        else:
            findings.append({"sev": "unknown", "label": "-", "state": "unknown",
                             "why": f"writer {trust}",
                             "text": f"window       cannot answer: presence writer is "
                                     f"{trust}, and a window running an extension older "
                                     f"than the marker writes nothing at all <- open "
                                     f"windows may exist and be invisible"})

    home = os.path.expanduser("~")
    state = STATE
    inbox = os.path.join(state, "inbox")
    # A synthetic frame in a live inbox is also a live id nobody owns. That happened:
    # a test message reached the daemon and rode out in every digest until the
    # disclosure bug was found, so the accident now has a detector rather than an
    # anecdote. Reported, never deleted -- it is evidence.
    strangers, artifacts = _inbox_artifact_report(state)
    # Ownership is not intended to be hand-edited. If consumer.json names a pid whose
    # session is not a live window here, the channel can be muted silently: the
    # incumbent sees a foreign pid, stops heartbeating AND stops delivering, while the
    # new pid never claims. Reported as a note, because a box can be deliberately quiet.
    owner = _ownership_note(STATE)
    if owner:
        findings.append({"sev": "note", "text": owner})

    # NOTE severity, deliberately: these are facts about DATA, not about running code.
    # The exit code answers "is the running system consistent with the disk"; a test
    # frame in an inbox breaks no run. They are still in the account, so the printed
    # line and the status are derived from one list -- severity is what stops them
    # turning a clean install red.
    if artifacts:
        findings.append({"sev": "note",
                         "text": f"artifacts    {len(artifacts)} inbox record(s) from a "
                                 f"malformed fingerprint: {', '.join(artifacts[:4])}  <- "
                                 f"test frames that reached production data"})
    if strangers:
        findings.append({"sev": "note",
                         "text": f"unowned      {len(strangers)} inbox record(s) from "
                                 f"senders not on the allowlist: "
                                 f"{', '.join(strangers[:4])}  <- these are not shipped "
                                 f"in digests, but they are still stored here"})
    for f in findings:
        print(f["text"])

    # The extension resolves RECEIVE from the PI process's environment. doctor
    # usually runs in a different shell, where the same variable may be set,
    # unset, or set differently -- so its own env is NOT evidence of what the
    # extension does. Prefer what the extension published at session start; fall
    # back to env only when there is no report, and say which one was used.
    global MY_SESSION, RECEIVE_TARGETED
    ext_info, ext_source = None, "env (extension has never reported)"
    # The extension resolves its state directory by its own rules (explicit
    # TORAGENTS_STATE, then TORAGENTS_HOME/state, then a scored choice among the
    # defaults). Reading the report from doctor's default two-line guess meant
    # that on any machine where those differ -- which is the whole reason the
    # extension has scoring -- doctor found nothing and fell back to the shell.
    candidates = []
    if os.environ.get("TORAGENTS_STATE"):
        candidates.append(os.environ["TORAGENTS_STATE"])
    if os.environ.get("TORAGENTS_HOME"):
        candidates.append(os.path.join(os.environ["TORAGENTS_HOME"], "state"))
    candidates.append(state)
    candidates.append(os.path.join(os.path.expanduser("~"), ".toragents", "state"))
    candidates.append("/var/lib/toragents-inbox")
    seen, uniq = set(), []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            uniq.append(c)
    for cand in uniq:
        try:
            with open(os.path.join(cand, "extension.json"), encoding="utf-8") as f:
                ext_info = json.load(f)
        except (OSError, ValueError, TypeError):
            continue
        when = time.strftime("%H:%M", time.localtime(float(ext_info.get("at", 0)) / 1000))
        ext_source = f"extension.json (last seen {when})"
        reported_state = str(ext_info.get("state") or "").strip()
        if reported_state and reported_state != state:
            # The extension is watching a different directory than this command
            # is inspecting. Say so and read ITS state, because that is the world
            # the labels are supposed to describe.
            print(f"  WARNING      the extension watches {reported_state}")
            print(f"               this command looked in {state}")
            state = reported_state
            inbox = os.path.join(state, "inbox")
        break
    if ext_info is None:
        state_line = state
        print(f"  state        {state_line}")
    if isinstance(ext_info, dict):
        MY_SESSION = str(ext_info.get("session") or "").strip()
        RECEIVE_TARGETED = str(ext_info.get("receive") or "all").strip().lower() == "targeted"
    else:
        MY_SESSION = (os.environ.get("TORAGENTS_SESSION") or "").strip() or auto_session()
        RECEIVE_TARGETED = (os.environ.get("TORAGENTS_RECEIVE") or "all").strip().lower() == "targeted"

    def count(d):
        try:
            return len([n for n in os.listdir(d) if n.endswith(".json")])
        except OSError:
            return -1

    if ext_info is not None:
        print(f"  state        {state}")
    n_inbox = count(inbox)
    print(f"  inbox        {'no directory yet (nothing has arrived)' if n_inbox < 0 else str(n_inbox) + ' file(s) waiting'}")
    try:
        import json as _j
        announced = _j.load(open(os.path.join(state, "announced.json")))
        announced = announced if isinstance(announced, list) else list(announced)
    except Exception:
        announced = []
    print(f"  announced    {len(announced)} already delivered")
    for name in ("onion.txt", "config.json", "peers.json"):
        fp = os.path.join(state, name)
        print(f"  {name:12} {'present' if os.path.exists(fp) else 'MISSING'}")

    # The only thing that turns a file into a message the agent can see.
    print("\n  pi extension")
    # pi honours PI_CODING_AGENT_DIR; assuming ~/.pi/agent is the same class of
    # mistake as assuming a settings file path. Resolve it, and say which.
    pi_dir = os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(home, ".pi", "agent")
    ext_dir = os.path.join(pi_dir, "extensions")
    ext = os.path.join(ext_dir, "toragents-inbox.ts")
    if os.path.exists(ext):
        size = os.path.getsize(ext)
        print(f"  installed    {ext} ({size} bytes)")
    else:
        print(f"  MISSING      {ext}")
        print("               messages will pile up and never reach the session.")
        print("               Re-run the installer, or copy toragents_watch.ts there.")
    print(f"  pi dir       {pi_dir} "
          f"({'present' if os.path.isdir(pi_dir) else 'MISSING'}"
          f"{', from PI_CODING_AGENT_DIR' if os.environ.get('PI_CODING_AGENT_DIR') else ''})")
    print(f"  resolves     receive={('targeted' if RECEIVE_TARGETED else 'all')} "
          f"session={MY_SESSION or '(none)'} -- from {ext_source}")

    # Who took the mail, read from the claim files themselves. The extension
    # writes "<session> <ms>" when it claims a message, so this needs no second
    # file and survives announced.json being lost. (The previous version read
    # delivered_by.json, whose only writer was the hook -- so on every pi-only
    # machine this section printed nothing and claimed otherwise.)
    try:
        claim_dir = os.path.join(state, "claimed")
        claims = []
        for name in os.listdir(claim_dir):
            try:
                with open(os.path.join(claim_dir, name), encoding="utf-8") as f:
                    who = f.read().strip()
            except OSError:
                who = "?"
            parts = who.split()
            claims.append((int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0,
                           name, parts[0] if parts else "?"))
        claims.sort(reverse=True)
        print(f"  claimed      {len(claims)} message(s) owned")
        if claims:
            print("  recently delivered by")
            for _ts, mid, who in claims[:5]:
                when = time.strftime("%H:%M", time.localtime(_ts / 1000)) if _ts else "?"
                print(f"  {mid:14} {when}  by {who}")
    except FileNotFoundError:
        pass
    except OSError:
        pass

    # Failures must be visible somewhere, or "delivered" is a lie.
    try:
        failed = sorted(os.listdir(os.path.join(state, "failed")))
    except OSError:
        failed = []
    if failed:
        print(f"  failed       {len(failed)}: {', '.join(failed[:5])}")
        print("               NOT delivered. Run /toragents-retry inside pi.")

    # What is sitting there, and whether the extension has already announced it.
    print("\n  waiting")
    try:
        names = sorted((n for n in os.listdir(inbox) if n.endswith(".json")), reverse=True)
    except OSError:
        names = []
    if not names:
        print("  none")
        return 0
    for n in names[:8]:
        try:
            import json as _j
            m = _j.load(open(os.path.join(inbox, n), encoding="utf-8"))
        except Exception:
            print(f"  {n}  unreadable")
            continue
        mid = str(m.get("id") or "?")
        to_sess = (m.get("to_session") or "").strip()
        if mid in announced:
            state_word = "delivered"
        elif RECEIVE_TARGETED and not to_sess:
            # In the documented quiet-box mode an untargeted message is filtered
            # out before it is ever claimed. No tick, retry or restart will
            # deliver it, so calling it PENDING (waiting for something that will
            # happen) is a lie.
            state_word = "UNROUTABLE"
        elif to_sess and to_sess != MY_SESSION:
            # Correctly addressed to another session. Unlabelled, a human running
            # doctor in the wrong window reads it as stuck mail.
            state_word = f"for {to_sess[:9]}"
        else:
            state_word = "PENDING"
        print(f"  {mid:14} {state_word:12} to={to_sess or '-':18} "
              f"from={m.get('from_label') or m.get('from') or '?'}")
    # Exit codes carry the ACTION, not just failure:
    #   0  known and fine
    #   1  known and WRONG   -> fix something (stale daemon/window against a live writer)
    #   2  cannot answer     -> wait for a window to speak; nothing is known to be wrong
    # One code for both would make a script wait when it should repair, or repair a
    # state that is merely unknown -- the same lossy compression we removed all day.
    wrong = [f for f in findings if f["sev"] == "wrong"]
    unknown = [f for f in findings if f["sev"] == "unknown"]
    if wrong:
        print(f"\n{len(wrong)} KNOWN mismatch(es): something running here is not the "
              f"code on disk. /reload the window(s) marked stale, or restart the daemon.")
        return 1
    if unknown:
        print(f"\n{len(unknown)} thing(s) cannot be answered: no fresh heartbeat writer, "
              f"and a window running an extension older than the marker writes nothing. "
              f"Nothing is known to be wrong; start or reload a window.")
        return 2
    return 0


def cmd_serve(a):
    print(f"[inbox] running inbox_agent.py sha256={_self_fingerprint()} "
          f"state={STATE}", flush=True)
    serve()


def cmd_init(a):
    existed = os.path.exists(IDFILE)
    k = keys(create=True)
    print(f"{'existing' if existed else 'created'}  {IDFILE}")
    print(f"fingerprint  {k.public().fingerprint}")
    if existed:
        print("onion        unchanged (identity reused)")


def cmd_whoami(a):
    k = keys()                      # never creates
    print(f"onion        {onion() or '(not configured)'}")
    if k is None:
        print(f"fingerprint  (no identity yet - run: inbox_agent.py init)")
        raise SystemExit(2)
    print(f"fingerprint  {k.public().fingerprint}")


def _writable_peers():
    """Allowlist for a read-modify-write. Refuses to start from a bad file.

    Rewriting a file you could not read is how one broken allowlist becomes one
    peer and a silent revocation of everyone else.
    """
    status, p = peers_state()
    if status in (PEERS_UNREADABLE, PEERS_CORRUPT):
        sys.exit(f"refusing to modify {PEERS}: it is {status}. "
                 f"Fix or delete the file first.")
    return p or {}


def cmd_add_peer(a):
    p = _writable_peers()
    fp = a.fingerprint.strip().lower()
    if len(fp) != 32:
        sys.exit(f"fingerprint must be 32 hex chars (got {len(fp)})")
    if not a.onion.endswith(".onion"):
        sys.exit("--onion must end in .onion")
    p[fp] = {"onion": a.onion.strip(), "label": a.label or fp[:12],
             "added": time.time()}
    save_peers(p)
    print(f"allowlisted {p[fp]['label']} ({fp[:12]}...) -> {a.onion}")


def cmd_tone(a):
    """Per-peer voice: read it when composing, don't try to remember it."""
    p = _writable_peers()
    wanted = (a.label or "").strip().lower()
    matches = [(fp, v) for fp, v in p.items()
               if (v.get("label") or "").lower() == wanted or fp.startswith(wanted)]
    if not matches:
        sys.exit(f"no peer matching {a.label!r} (see `inbox peers`)")
    fp, v = matches[0]

    if a.clear:
        v.pop("tone", None)
        v.pop("styles", None)
        p[fp] = v
        save_peers(p)
        print(f"cleared tone and styles for {v.get('label')}")
        return

    changed = False
    if a.styles is not None:
        # Styles drive which decks the picker draws from: an agent-flavoured
        # profile for one peer, plain for another.
        v["styles"] = [x.strip().lower() for x in a.styles.split(",") if x.strip()]
        changed = True
    if a.text:
        v["tone"] = " ".join(a.text).strip()
        changed = True
    if changed:
        p[fp] = v
        save_peers(p)
    print(v.get("tone") or f"(no tone set for {v.get('label')} — plain register)")
    if v.get("styles"):
        print(f"styles: {', '.join(v['styles'])}")


def _seed_path():
    """Installers drop the seed beside the daemon; a repo checkout keeps it in
    docs/. Both are legitimate, so look in both rather than assuming one."""
    here = Path(__file__).resolve().parent
    for cand in (here / "lexicon.seed.json", here / "docs" / "lexicon.seed.json"):
        if cand.exists():
            return cand
    return here / "lexicon.seed.json"


LEXICON_SEED = _seed_path()


def _lexicon_path():
    return Path(STATE) / "lexicon.json"


def _lexicon():
    """The pool, seeded on first use and self-healing if it is unreadable.

    A corrupt pool must never take the channel down: this is decoration, and
    falling back to the seed costs one file read. But a *programming* error here
    must not be swallowed either -- the first version of this merge caught its own
    UnboundLocalError and quietly half-merged, so `stats` reported counts the pool
    did not hold.
    """
    path = _lexicon_path()
    if not path.exists():
        try:
            seed = json.loads(LEXICON_SEED.read_text())
        except Exception:
            return {"version": 1, "names": [], "moves": []}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(seed, indent=1, ensure_ascii=False))
        return seed

    try:
        d = json.loads(path.read_text())
    except Exception:
        try:
            return json.loads(LEXICON_SEED.read_text())
        except Exception:
            return {"version": 1, "names": [], "moves": []}

    d.setdefault("names", [])
    d.setdefault("moves", [])
    try:
        seed = json.loads(LEXICON_SEED.read_text())
    except Exception:
        return d          # no seed to learn from; the pool we have is still valid

    # Absorb decks added since this pool was created. Keyed by (style, text), not
    # text alone: "good machine" is a praise word AND an earnest one, and matching
    # on text dropped it from whichever deck it did not already belong to.
    added = removed = reflagged = 0
    for kind in ("names", "moves"):
        seed_keys = {((r.get("style") or "custom"), (r.get("text") or "").lower())
                     for r in seed.get(kind, [])}
        # A word deleted from a deck must leave the pool, or "get rid of peach"
        # is advice rather than a change. Hand-added rows (style "custom") are
        # never pruned: the pool is theirs.
        kept = []
        for r in d.get(kind, []):
            key = ((r.get("style") or "custom"), (r.get("text") or "").lower())
            if (r.get("style") or "custom") != "custom" and key not in seed_keys:
                removed += 1
                continue
            kept.append(r)
        d[kind] = kept
        # Flags are seed-owned too: hunni was added to the pool before it was
        # marked rare, and a pool that ignores the flag keeps offering it.
        seed_rare = {((r.get("style") or "custom"), (r.get("text") or "").lower())
                     for r in seed.get(kind, []) if r.get("rare")}
        for r in d.get(kind, []):
            key = ((r.get("style") or "custom"), (r.get("text") or "").lower())
            should = key in seed_rare
            if bool(r.get("rare")) != should:
                if should:
                    r["rare"] = True
                else:
                    r.pop("rare", None)
                reflagged += 1
        have = {((r.get("style") or "custom"), (r.get("text") or "").lower())
                for r in d.get(kind, [])}
        for r in seed.get(kind, []):
            key = (r.get("style") or "custom", (r.get("text") or "").lower())
            if key not in have:
                d[kind].append(dict(r, used=0, last=0))
                have.add(key)
                added += 1
        # old unstyled rows adopt the style of the seed entry they match
        index = {(r.get("text") or "").lower(): (r.get("style") or "custom")
                 for r in seed.get(kind, [])}
        for r in d.get(kind, []):
            if not r.get("style") or r["style"] == "custom":
                r["style"] = index.get((r.get("text") or "").lower(), "custom")
    if added or removed or reflagged:
        _lexicon_save(d)
    return d


def _lexicon_save(d):
    try:
        _lexicon_path().parent.mkdir(parents=True, exist_ok=True)
        _lexicon_path().write_text(json.dumps(d, indent=1, ensure_ascii=False))
    except Exception as e:
        print(f"warn: could not save lexicon ({e})", file=sys.stderr)


def _pick(entries, n, rng):
    """Least-recently-used, with a little shuffle inside the same usage tier.

    Rotation is the point: a pool that keeps handing back the same word is a
    pool that is shrinking in practice, however many rows it has.
    """
    ranked = sorted(entries, key=lambda e: (e.get("used", 0), e.get("last", 0)))
    pool = ranked[: max(n * 3, n)]
    rng.shuffle(pool)
    return pool[:n]


def _styles_summary(d):
    seen = {}
    for k in ("names", "moves"):
        for r in d.get(k, []):
            sid = r.get("style") or "custom"
            e = seen.setdefault(sid, {"names": 0, "moves": 0})
            e[k] += 1
    return seen


def cmd_lexicon(a):
    import random
    d = _lexicon()
    kind = a.kind
    if a.action == "stats":
        for k in ("names", "moves"):
            rows = d.get(k, [])
            used = sum(1 for r in rows if r.get("used"))
            print(f"{k:6} {len(rows):3} entries · {used} used at least once")
        print("-- by style")
        for sid, c in sorted(_styles_summary(d).items()):
            print(f"   {sid:16} {c['names']:3} names · {c['moves']:3} moves")
        return
    if a.action == "styles":
        for sid, c in sorted(_styles_summary(d).items()):
            print(f"{sid:16} {c['names']:3} names · {c['moves']:3} moves")
        return
    if a.action == "add":
        # REMAINDER swallows options that follow the action, so pull --kind back
        # out instead of treating "--kind names" as part of the phrase. (It did.)
        toks, keep, i = (a.text or []), [], 0
        while i < len(toks):
            if toks[i] == "--kind" and i + 1 < len(toks):
                kind = toks[i + 1]
                i += 2
                continue
            if toks[i].startswith("--kind="):
                kind = toks[i].split("=", 1)[1]
                i += 1
                continue
            keep.append(toks[i])
            i += 1
        text = " ".join(keep).strip()
        if not text:
            sys.exit("nothing to add")
        rows = d.setdefault(kind, [])
        if any(r["text"].lower() == text.lower() for r in rows):
            print(f"already in {kind}: {text}")
            return
        prefix = "n" if kind == "names" else "m"
        style = (a.style or "custom").split(",")[0].strip().lower()
        rows.append({"id": f"{prefix}{len(rows)+1:03d}", "text": text, "style": style,
                     "used": 0, "last": 0, "at": time.time()})
        _lexicon_save(d)
        print(f"added to {kind} ({len(rows)} total): {text}")
        return
    if a.action == "pick":
        rng = random.Random(a.seed) if a.seed is not None else random.Random()
        out = {}
        # A body that already used a word marks it used, so the next pick
        # rotates away from it without anyone having to keep a ledger by hand.
        body = ""
        if a.body_file:
            body = sys.stdin.read() if a.body_file == "-" else Path(a.body_file).read_text()
        touched = []
        low = body.lower()
        if low:
            for k in ("names", "moves"):
                for r in d.get(k, []):
                    if r["text"].lower().split("{")[0].strip() and r["text"].lower().split("{")[0].strip() in low:
                        r["used"] = r.get("used", 0) + 1
                        r["last"] = int(time.time())
                        touched.append(r["id"])
        wanted = [x.strip().lower() for x in (a.style or "").split(",") if x.strip()]
        if wanted:
            known = set(_styles_summary(d))
            unknown = [w for w in wanted if w not in known]
            if unknown:
                sys.exit(f"no such style: {', '.join(unknown)} (known: {', '.join(sorted(known))})")
        def allowed(r):
            if wanted and (r.get("style") or "custom") not in wanted:
                return False
            # A rare word (hunni, honey) is offered only occasionally: everyday
            # rotation of a diminutive is what makes a pet name feel like a field
            # in a form. --rare-chance 0 keeps them out entirely, 1 always allows.
            if r.get("rare") and rng.random() >= a.rare_chance:
                return False
            return True
        for k in ("names", "moves"):
            picks = _pick([r for r in d.get(k, []) if allowed(r)], a.count, rng)
            out[k] = [{"id": r["id"], "text": r["text"]} for r in picks]
            if not a.peek:
                # peek must not consume rotation: prompt-time suggestions are
                # shown before anyone knows whether they were used.
                for r in picks:
                    r["used"] = r.get("used", 0) + 1
                    r["last"] = int(time.time())
        if not a.peek:
            _lexicon_save(d)
        if a.json:
            print(json.dumps({"ok": True, "picked": out, "marked": touched,
                              "sizes": {k: len(d.get(k, [])) for k in ("names", "moves")}}))
        else:
            for k in ("names", "moves"):
                print(f"-- {k}")
                for r in out[k]:
                    print(f"   {r['text']}")
            if touched:
                print(f"marked used: {', '.join(touched)}")
        return
    sys.exit(f"unknown lexicon action {a.action}")


def _chat_rows(limit=40):
    path = Path(STATE) / "chat.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines()[-400:]:
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows[-limit:]


def _wrap(text, width):
    words, line, out = text.split(), "", []
    for w in words:
        if len(line) + len(w) + 1 > width:
            out.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    if line:
        out.append(line)
    return out or [""]


def render_chat(rows, width=54):
    """The conversation, not the work: only bodies that crossed the wire."""
    if not rows:
        return [" no messages yet"]
    out = []
    for r in rows:
        when = time.strftime("%H:%M", time.localtime(r.get("at", 0) / 1000))
        arrow = "→" if r.get("dir") == "out" else "←"
        out.append(f" {arrow} {r.get('peer','peer')}  {when}")
        body = " ".join(str(r.get("body", "")).split())
        for line in _wrap(body, width):
            out.append(f"   {line}")
        out.append("")
    return out[:-1]


def cmd_chat(a):
    """Print the transcript, or follow it: this is the side-pane viewer."""
    rows = _chat_rows(a.limit)
    width = max(30, a.width)
    print("\n".join(render_chat(rows, width)))
    if not a.follow:
        return
    path = Path(STATE) / "chat.jsonl"
    seen = len(rows)
    while True:
        time.sleep(1.0)
        try:
            all_rows = _chat_rows(1000)
        except Exception:
            continue
        if len(all_rows) > seen:
            for line in render_chat(all_rows[seen:], width):
                print(line, flush=True)
            seen = len(all_rows)


def cmd_peers(a):
    p = peers()
    if not p:
        print("(no peers allowlisted)")
    for fp, v in sorted(p.items(), key=lambda kv: kv[1].get("label", "")):
        tone = v.get("tone")
        print(f"{v.get('label',''):18} {fp[:16]}...  {v['onion']}"
              + (f"\n{'':18} tone: {tone}" if tone else ""))


def _msgs(include_archived=False):
    out = []
    for d, arch in ((INBOX, False), (ARCHIVE, True)):
        if not os.path.isdir(d):
            continue
        if arch and not include_archived:
            continue
        for n in sorted(os.listdir(d)):
            if n.endswith(".json"):
                try:
                    with open(os.path.join(d, n)) as f:
                        m = json.load(f)
                    m["_archived"] = arch
                    out.append(m)
                except Exception:
                    pass
    return sorted(out, key=lambda m: m.get("received", 0))


def cmd_inbox(a):
    ms = _msgs(a.all)
    if not ms:
        print("(inbox empty)")
    for m in ms:
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(m.get("received", 0)))
        who = m.get("from_label", "?")
        if m.get("from_session"):
            who = f"{who}/{m['from_session']}"
        if m.get("to_session"):
            who = f"{who} -> {m['to_session']}"
        print(f"{m['id']}  {when}  {who[:30]:30} "
              f"{(m.get('body') or '').replace(chr(10),' ')[:60]}")


def cmd_read(a):
    for m in _msgs(True):
        if m["id"] == a.id:
            print(json.dumps(m, indent=2))
            return
    sys.exit(f"no message {a.id}")


def cmd_ack(a):
    for n in (os.listdir(INBOX) if os.path.isdir(INBOX) else []):
        if a.id in n:
            os.replace(os.path.join(INBOX, n), os.path.join(ARCHIVE, n))
            print(f"archived {a.id}")
            return
    sys.exit(f"no unarchived message {a.id}")


def _read_body(a):
    """Body from a file is taken verbatim; body from argv is not trustworthy.

    A double-quoted argument is expanded by the sending shell, so prose that
    mentions a substitution loses it before this process runs -- measured on the
    other side of this wire five times, in sentences describing that very
    mechanism. Reading the file means the bytes on the wire are the bytes in the
    file, which is also the only way a send-side fingerprint can mean anything.
    """
    path = getattr(a, "body_file", None)
    if not path:
        if a.body is None:
            sys.exit("send: give --body or --body-file")
        return a.body
    if a.body is not None:
        sys.exit("send: --body and --body-file are mutually exclusive")
    try:
        if path in ("-", "/dev/stdin"):
            data = sys.stdin.buffer.read()
        else:
            with open(path, "rb") as f:
                data = f.read()
    except OSError as e:
        sys.exit(f"send: cannot read --body-file {path}: {e.strerror}")
    try:
        # A BOM is an encoding marker, not content: Windows editors and
        # `Set-Content -Encoding utf8` add one, and it would otherwise arrive as
        # the first character of the message.
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        sys.exit(f"send: --body-file is not valid UTF-8: {e}")


def cmd_send(a):
    a.body = _read_body(a)
    p = peers()
    target = None
    for fp, v in p.items():
        if a.to in (fp, v.get("label"), fp[:12]):
            target = v
            break
    if target is None:
        sys.exit(f"unknown peer {a.to!r}; try: inbox_agent.py peers")
    rec = sent_intent(target.get("label") or a.to, target.get("onion"), a.body)
    try:
        reply = send_to(target["onion"], a.body,
                        session=getattr(a, "session", None) or auto_session() or None,
                        to_session=getattr(a, "to_session", "") or None,
                        peer_fp=fp_of(target, p), peer_label=target.get("label"))
    except BaseException:
        sent_confirm(rec, None)                 # attempted and did not complete
        raise
    sent_confirm(rec, reply)
    print(json.dumps(reply, indent=2))
    sys.exit(0 if reply and reply.get("ok") else 1)


# ------------------------------------------------------------- tier 2: dg --
#
# A digest is an INDEX of what each side holds, never the bodies. Two lists:
#   a = ids the sender claims to hold OF OURS (attestations about our outbound)
#   b = ids the sender holds OF ITS OWN (announcing what it sent us)
# Every item is {id, h, n}: id, 128-bit body hash, byte length. Nothing else,
# because a body inside a digest is the thing this design exists to avoid.

DG_MAX_ITEMS = 512
DG_MAX_BYTES = 64 * 1024
DG_MAX_BODY = 16 * 1024 * 1024
DG_STATES = ("delivered-both", "accepted-only", "never-stored", "mismatch", "stale")
DG_ID_RE = re.compile(r"^[0-9a-zA-Z_-]{1,64}$")
DG_H_RE = re.compile(r"^[0-9a-f]{32}$")
DG_TOP_KEYS = {"v", "gen", "a", "b", "dsig"}


def dg_canon(d):
    return json.dumps(d, sort_keys=True, separators=(",", ":")).encode("utf-8")


def dg_hash(body):
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]


def dg_item(mid, body):
    return {"id": mid, "h": dg_hash(body), "n": len(body.encode("utf-8"))}


def dg_validate(d):
    """Strict. Returns (ok, why) -- never raises, because a bad digest must not
    be able to break delivery."""
    if not isinstance(d, dict):
        return False, "dg is not an object"
    extra = set(d) - DG_TOP_KEYS
    if extra:
        return False, f"unknown field(s) in dg: {', '.join(sorted(extra))}"
    if d.get("v") != 1:
        return False, "unsupported dg version"
    total = 0
    for side in ("a", "b"):
        items = d.get(side, [])
        if not isinstance(items, list):
            return False, f"dg.{side} is not a list"
        total += len(items)
        for it in items:
            if not isinstance(it, dict):
                return False, f"dg.{side} contains a non-object item"
            if set(it) != {"id", "h", "n"}:
                return False, f"dg item has wrong field(s): {sorted(it)}"
            if not isinstance(it["id"], str) or not DG_ID_RE.match(it["id"]):
                return False, "dg item id must be 1..64 of [0-9a-zA-Z_-]"
            if not isinstance(it["h"], str) or not DG_H_RE.match(it["h"]):
                return False, "dg item h must be exactly 32 lowercase hex (128-bit)"
            n = it["n"]
            if isinstance(n, bool) or not isinstance(n, int) or n < 0 or n > DG_MAX_BODY:
                return False, "dg item n must be an int 0..16 MiB"
    if total > DG_MAX_ITEMS:
        return False, f"dg carries {total} items; the bound is {DG_MAX_ITEMS}"
    size = len(dg_canon({k: v for k, v in d.items() if k != "dsig"}))
    if size > DG_MAX_BYTES:
        return False, f"serialised dg is {size} bytes; the cap is {DG_MAX_BYTES}"
    return True, ""


def dg_build(rows_a=(), rows_b=(), now=None):
    """Build our digest from records. Accepts records that still carry `body`
    (ours) and items that are already {id,h,n}; only the three keys survive."""
    a = []
    for r in rows_a or ():
        if not isinstance(r, dict):
            continue
        mid = r.get("id") or r.get("peer_id") or r.get("local_id")
        if not mid:
            continue
        if "h" in r and "n" in r:
            a.append({"id": mid, "h": r["h"], "n": r["n"]})
        elif isinstance(r.get("body"), str):
            a.append(dg_item(mid, r["body"]))
    b = []
    for r in rows_b or ():
        if isinstance(r, dict) and {"id", "h", "n"} <= set(r):
            b.append({"id": r["id"], "h": r["h"], "n": r["n"]})
    a, b = a[:DG_MAX_ITEMS], b[:DG_MAX_ITEMS - min(len(a), DG_MAX_ITEMS)]
    return {"v": 1, "gen": now if now is not None else time.time(), "a": a, "b": b}


LIVE_STALE_MS = 90_000


def live_labels(state_dir):
    """Labels with a live pi session on THIS box.

    Liveness lives in the extension -- only it knows a window exists -- so each
    session writes state/live/<label>.json on start, refreshes it on every tick,
    and removes it on shutdown. The daemon then judges liveness the same way it
    judges the consumer lease: pid alive AND fresh. Judging only this box is
    deliberate: a label living on another machine is correctly "not here".
    """
    d = os.path.join(state_dir, "live")
    live = {}
    if not os.path.isdir(d):
        return live
    now = time.time()
    for name in os.listdir(d):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, name)) as f:
                rec = json.load(f)
        except Exception:
            continue
        label = rec.get("session") or name[:-5]
        # The extension writes Date.now(): MILLISECONDS. Comparing that to
        # time.time() gave age = -1.79e12, so `age < 90` was always true and
        # freshness was decided by the pid alone -- a wedged session with a live
        # pid stayed "live" forever and mail was accepted into a window that would
        # never read it. Compare ms to ms, then convert to seconds.
        age = (now * 1000.0 - float(rec.get("at") or 0)) / 1000.0
        pid = rec.get("pid")
        alive = False
        if isinstance(pid, int) and pid > 0:
            try:
                os.kill(pid, 0)
                alive = True
            except OSError:
                alive = False
        live[label] = alive and age < (LIVE_STALE_MS / 1000.0)
    return live


WRITER_FILE = "_writer.json"

# The build of the EXTENSION this code expects. Must equal EXT_VERSION in
# toragents_watch.ts; tools/test_ext_version.py fails if they drift.
#
# Why a separate number at all: `code file= daemon=` compares two halves of the
# RECEIVER, and both of them run on this box. A pi window loads its module at start
# and is invisible to that comparison -- so a stale window passes every check we had
# while running old delivery logic. That is the trap this number exists to expose.
EXPECTED_EXT_VERSION = "8"


def writer_state(state_dir):
    """Can this box's presence registry be trusted to answer?

    Returns "trusted" | "absent" | "stale".

    The failure this exists for: a peer on an OLD build writes NO presence at all.
    Their windows are open, the registry is empty, and a targeted message is refused
    "no live session on this box" -- which is not "cannot address", it is "cannot
    receive", for exactly the mail the sender cared about. Presence may gate
    addressing; it must never gate delivery.

    So absence is the UNTRUSTED default, not evidence of absence. Only a fresh
    heartbeat marker lets an empty registry mean "no windows here", which is the one
    reading that licenses a refusal:

      marker fresh, pid alive, code current -> trusted (an empty registry means none)
      marker fresh but older code            -> unversioned -> cannot answer
      marker fresh, pid alive  -> trusted -> an empty registry really does mean none
      marker absent            -> absent  -> we cannot answer; accept unverified
      marker present but stale -> stale   -> the writer died; do not trust it either
      marker names a dead pid  -> stale   -> same

    A marker in a directory where nothing ever ran cannot exist, and that is the
    point: the unknown case has to be the safe one.
    """
    p = os.path.join(state_dir, "live", WRITER_FILE)
    if not os.path.exists(p):
        return "absent"
    try:
        with open(p) as f:
            rec = json.load(f)
    except (OSError, ValueError):
        return "absent"
    age = (time.time() * 1000.0 - float(rec.get("at") or 0)) / 1000.0
    pid = rec.get("pid")
    alive = False
    if isinstance(pid, int) and pid > 0:
        try:
            os.kill(pid, 0)
            alive = True
        except OSError:
            alive = False
    if not alive or age >= (LIVE_STALE_MS / 1000.0):
        return "stale"
    # The marker that LICENSES A REFUSAL must itself be current. A pre-version
    # extension writes a fresh marker with no `code` (or an older one), and trusting
    # it lets an old window authorise the daemon to refuse mail it cannot receive --
    # the trust anchor exempt from the check it exists to enable. Below expectation =
    # cannot answer = accept unverified, which is the safe direction.
    code = str(rec.get("code") or "")
    if code != EXPECTED_EXT_VERSION:
        return "unversioned"
    return "trusted"


def _seen_path(state_dir):
    return os.path.join(state_dir, "seen.json")


def _load_seen(state_dir):
    """Tolerant: a corrupt store must never stop delivery. Returns (data, error)."""
    p = _seen_path(state_dir)
    if not os.path.exists(p):
        return {"v": 1, "peers": {}}, None
    try:
        with open(p) as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get("peers"), dict):
            return {"v": 1, "peers": {}}, "unrecognised shape"
        return data, None
    except Exception as e:
        return {"v": 1, "peers": {}}, str(e)


def _save_seen(state_dir, data):
    p = _seen_path(state_dir)
    os.makedirs(state_dir, exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)


def _load_sent(state_dir):
    out = {}
    d = os.path.join(state_dir, "sent")
    if not os.path.isdir(d):
        return out
    for name in os.listdir(d):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, name)) as f:
                r = json.load(f)
        except Exception:
            continue
        out[r.get("local_id")] = r
        if r.get("peer_id"):
            out[r["peer_id"]] = r
    return out


def _load_inbox(state_dir):
    out = {}
    d = os.path.join(state_dir, "inbox")
    if not os.path.isdir(d):
        return out
    for name in os.listdir(d):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, name)) as f:
                r = json.load(f)
        except Exception:
            continue
        if r.get("id"):
            out[r["id"]] = r
    return out


def _journal_dirs(state_dir, mid):
    """Which directions chat.jsonl has seen for this id: {"in", "out"} subset.

    The journal is the only local history that survives a store gap, so it is what
    turns "could not anchor this id" into a claim about WHY. A reconciler that
    prints one sentence for three different causes is accusing whichever cause it
    happens to name first -- and the one it names first blames the peer.
    """
    dirs = set()
    p = os.path.join(state_dir, "chat.jsonl")
    if not os.path.exists(p):
        return dirs
    try:
        with open(p) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("id") == mid and r.get("dir"):
                    dirs.add(r["dir"])
    except OSError:
        return dirs
    return dirs


def dg_reconcile_row(row):
    """§4 precedence: never-stored > mismatch > delivered-both > accepted-only."""
    peer_h = row.get("peer_h")
    if peer_h is None:
        return "accepted-only"
    if row.get("h") is None:
        return "never-stored"          # a claim with no local anchor is a fabrication
    if peer_h != row.get("h"):
        return "mismatch"
    pn, n = row.get("peer_n"), row.get("n")
    if pn is not None and n is not None and pn != n:
        return "mismatch"              # a length the hash cannot explain is a contradiction
    return "delivered-both"


def dg_apply(state_dir, fp, dg):
    """Merge a received digest into seen.json. Never raises on bad input."""
    ok, why = dg_validate(dg)
    data, err = _load_seen(state_dir)
    peers = data.setdefault("peers", {})
    peer = peers.setdefault(fp, {"rows": {}, "orphans": [], "caps": {"dg": True, "last": 0},
                                 "counters": {"dg_in": 0, "dg_bad": 0, "stored": 0, "dropped": 0}})
    rows = peer.setdefault("rows", {})
    counts = peer.setdefault("counters", {"dg_in": 0, "dg_bad": 0, "stored": 0, "dropped": 0})
    if not ok:
        counts["dg_bad"] = counts.get("dg_bad", 0) + 1
        _save_seen(state_dir, data)
        return {"ok": False, "error": why, "rows": rows}
    counts["dg_in"] = counts.get("dg_in", 0) + 1
    sent = _load_sent(state_dir)
    inbox = _load_inbox(state_dir)
    counts["stored"] = len({r.get("local_id") for r in sent.values()})
    touched = {}
    for it in dg.get("a", []):
        mid, ph, pn = it["id"], it["h"], it["n"]
        mine = sent.get(mid)
        row = rows.get(mid) or {"id": mid, "owner": "me", "at": time.time(), "peer_fp": fp,
                                "n": None, "h": None, "body": False, "peer_at": None,
                                "peer_n": None, "peer_h": None, "state": "", "why": "",
                                "peer_first": False, "announced": False}
        if mine:
            row["h"], row["n"], row["body"] = mine.get("sha256"), mine.get("len"), True
        else:
            # The store no longer holds this id. Clearing the anchor is the whole
            # point: without it a row that matched ONCE keeps that match forever,
            # and later digests reconcile delivered-both off evidence that is gone.
            # "We still know" must become "we no longer know" the moment the proof
            # disappears -- the same direction as every other fix (missing registry,
            # missing claim, missing anchor: absence never inherits an old verdict).
            row["h"], row["n"], row["body"] = None, None, False
        if row.get("peer_h") is not None and row["peer_h"] != ph:
            row["state"], row["why"] = "mismatch", "id-reuse: same id, different body hash"
            touched[mid] = row
            continue                      # never overwrite the first hash we saw
        row["peer_h"], row["peer_n"], row["peer_at"] = ph, pn, time.time()
        row["state"] = dg_reconcile_row(row)
        if row["state"] != "never-stored":
            row["why"] = ""
        else:
            # Three separable causes, named instead of merged. "never-stored" is a
            # state; blaming the peer is a verdict, and this function cannot see
            # their store.
            jd = _journal_dirs(state_dir, mid)
            if "out" in jd:
                row["why"] = ("could not anchor this id: the journal shows a send for "
                              "it, but our sent store has no record (our store gap)")
                row["cause"] = "store-gap"
            else:
                row["why"] = ("could not anchor this id: no local record of it here -- "
                              "it may predate our store, or belong to another conversation")
                row["cause"] = "unanchorable"
        row["announced"] = False
        rows[mid] = row
        touched[mid] = row
    for it in dg.get("b", []):
        mid, ph, pn = it["id"], it["h"], it["n"]
        got = inbox.get(mid)
        row = rows.get(mid) or {"id": mid, "owner": "peer", "at": time.time(), "peer_fp": fp,
                                "n": None, "h": None, "body": False, "peer_at": None,
                                "peer_n": None, "peer_h": None, "state": "", "why": "",
                                "peer_first": True, "announced": False}
        if got:
            row["h"], row["n"], row["body"] = dg_hash(got.get("body", "")), \
                len(got.get("body", "").encode()), True
        else:
            row["h"], row["n"], row["body"] = None, None, False
        row["peer_h"], row["peer_n"], row["peer_at"] = ph, pn, time.time()
        row["state"] = dg_reconcile_row(row)
        if row["state"] == "accepted-only" and not got:
            row["announced"] = True
            row["why"] = "announced by peer, not received here yet"
        rows[mid] = row
        touched[mid] = row
    peer["last_digest_at"] = time.time()
    peer["caps"] = {"dg": True, "last": 0}
    _save_seen(state_dir, data)
    return {"ok": True, "rows": touched}


def fp_of(target, peers_map):
    """The fingerprint that owns this peer record."""
    for fp, v in peers_map.items():
        if v is target:
            return fp
    return None


def dg_attach(state_dir, peer_fp=None, peer_label=None, peer_onion=None):
    """Our current digest.

    SIDES, which is the thing that was wrong: `a` is what WE minted -- ids we made
    when the peer's message arrived, so they live in our INBOX. `b` is what THEY
    minted for our messages, so they live in our SENT store under peer_id. Building
    `a` from sent (as this did) produces rows whose ids the receiver cannot anchor
    anywhere: every `a` row reconciled as never-stored, on both machines, while
    every message sat on disk. dg_apply was right the whole time.
    """
    got = {}
    d_in = os.path.join(state_dir, "inbox")
    if os.path.isdir(d_in):
        for name in sorted(os.listdir(d_in), key=lambda x: os.path.getmtime(os.path.join(d_in, x))):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(d_in, name)) as f:
                    r = json.load(f)
            except Exception:
                continue
            body = r.get("body")
            if not isinstance(body, str) or not r.get("id"):
                continue
            # DISCLOSURE: a digest is an index of THIS conversation. Sweeping the
            # whole inbox told every peer which other peers had written to us, with
            # body hashes and byte lengths -- third-party metadata, disclosed by a
            # feature whose entire premise is "index, not bodies". A synthetic test
            # frame rode out in every digest for the same reason.
            if peer_fp and r.get("from_fingerprint") != peer_fp:
                continue
            got[r["id"]] = {"id": r["id"], "h": dg_hash(body),
                            "n": len(body.encode("utf-8"))}
    sent = {}
    d = os.path.join(state_dir, "sent")
    if os.path.isdir(d):
        for name in sorted(os.listdir(d), key=lambda x: os.path.getmtime(os.path.join(d, x))):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(d, name)) as f:
                    r = json.load(f)
            except Exception:
                continue
            if r.get("state") != "confirmed":
                continue
            # Same rule on our own side: only rows addressed to THIS peer, or the
            # digest describes our correspondence with everyone else too.
            if peer_label and r.get("to") and r.get("to") != peer_label:
                continue
            if peer_onion and r.get("onion") and r.get("onion") != peer_onion:
                continue
            mid = r.get("peer_id") or r.get("local_id")
            sent[mid] = {"id": mid, "h": r.get("sha256"), "n": r.get("len")}
    return dg_build(list(got.values())[-DG_MAX_ITEMS:],
                    list(sent.values())[-DG_MAX_ITEMS:])


def cmd_sessions(a):
    """Known session labels, per peer, from the wire itself.

    Addressing a specific window needs its name, and the only source of truth for
    that is what the peer told us on messages they sent (from_session) and what we
    addressed on ours (to_session). Guessing a label is how a message ends up
    delivered to nobody.
    """
    labels = {}
    d = os.path.join(STATE, "inbox")
    if os.path.isdir(d):
        for name in os.listdir(d):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(d, name)) as f:
                    r = json.load(f)
            except Exception:
                continue
            lab = (r.get("from_session") or "").strip()
            if not lab:
                continue
            key = (r.get("from_label") or r.get("from_fingerprint", "")[:12], lab)
            cur = labels.setdefault(key, {"count": 0, "last": 0})
            cur["count"] += 1
            cur["last"] = max(cur["last"], r.get("received") or 0)
    if not labels:
        print("no peer session labels seen yet")
        return
    for (peer, lab), v in sorted(labels.items(), key=lambda kv: -kv[1]["last"]):
        when = time.strftime("%m-%d %H:%M", time.localtime(v["last"])) if v["last"] else "-"
        print(f"{peer:<14} {lab:<24} {v['count']:>3} msgs  last {when}")
    print("\naddress one: inbox_agent.py send --to <peer> --to-session <label> ...")


def cmd_dg(a):
    action = getattr(a, "action", "show") or "show"
    if action == "build":
        d = dg_attach(STATE)
        print(json.dumps(d, indent=2)[:4000])
        return
    # `dg show` -- §7: the panel is part of the contract and nothing here may throw
    data, err = _load_seen(STATE)
    if err:
        print(f"digest: unavailable — {err}")
        return
    peers = data.get("peers") or {}
    if not peers:
        print("digest: no digests received yet — every peer is UNKNOWN, not up to date")
        return
    labels = {}
    try:
        for fp, v in peers().items():
            labels[fp] = v.get("label") or fp[:12]
    except Exception:
        pass
    for fp, peer in peers.items():
        rows = peer.get("rows") or {}
        counts = peer.get("counters") or {}
        last = peer.get("last_digest_at")
        from time import strftime, localtime
        if last is None:
            age_txt, stale = "never", True
        else:
            age = time.time() - last
            age_txt = f"{int(age)}s ago" if age < 600 else f"{age/3600:.1f}h ago"
            stale = age > 12 * 3600
        tally = {s: 0 for s in DG_STATES}
        for r in rows.values():
            tally[r.get("state", "accepted-only")] = tally.get(r.get("state", "accepted-only"), 0) + 1
        if stale:
            print(f"STALE: digest from {labels.get(fp, fp[:12])} is {age_txt} old — "
                  f"counters below are last known, not current")
            print(f"digest: {len(rows)} rows, stored {counts.get('stored', 0)}, "
                  f"in {counts.get('dg_in', 0)}, dropped {counts.get('dg_bad', 0)}")
        else:
            print(f"digest: {labels.get(fp, fp[:12])} {age_txt} "
                  f"({len(rows)} rows, stored {counts.get('stored', 0)})")
        print("  " + "  ".join(f"{k}={v}" for k, v in tally.items() if v))
        for mid, r in sorted(rows.items(), key=lambda kv: kv[1].get("at", 0))[-12:]:
            print(f"  {r.get('state','?'):<14} {mid}  {r.get('why','') or ''}".rstrip())


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    s = ap.add_subparsers(dest="cmd", required=True)
    s.add_parser("serve").set_defaults(fn=cmd_serve)
    s.add_parser("whoami").set_defaults(fn=cmd_whoami)
    s.add_parser("doctor").set_defaults(fn=cmd_doctor)
    s.add_parser("init").set_defaults(fn=cmd_init)
    s.add_parser("peers").set_defaults(fn=cmd_peers)
    p = s.add_parser("add-peer")
    p.add_argument("fingerprint")
    p.add_argument("--onion", required=True)
    p.add_argument("--label", default="")
    p.set_defaults(fn=cmd_add_peer)
    p = s.add_parser("lexicon")
    p.add_argument("action", choices=["pick", "add", "stats", "styles"], nargs="?", default="pick")
    p.add_argument("--style", default=None,
                   help="restrict to one or more styles: --style annoying,deadpan "
                        "(see `lexicon styles`)")
    p.add_argument("--kind", choices=["names", "moves", "both"], default="both")
    p.add_argument("--count", type=int, default=3)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--peek", action="store_true",
                   help="sample without marking anything used (prompt-time suggestions)")
    p.add_argument("--rare-chance", type=float, default=0.0,
                   help="probability of offering a word flagged rare (default 0)")
    p.add_argument("--body-file", default=None, help="mark words this body already used")
    p.add_argument("--json", action="store_true")
    p.add_argument("text", nargs="*", default=None,
                   help="for `add`: the words, as trailing arguments")
    p.set_defaults(fn=cmd_lexicon)
    p = s.add_parser("sessions")
    p.set_defaults(fn=cmd_sessions)
    p = s.add_parser("dg")
    p.add_argument("action", choices=["show", "build"], nargs="?", default="show")
    p.set_defaults(fn=cmd_dg)
    p = s.add_parser("sent")
    p.add_argument("action", choices=["list", "verify", "show"], nargs="?", default="list")
    p.add_argument("id", nargs="?", default="")
    p.set_defaults(fn=cmd_sent)
    p = s.add_parser("chat")
    p.add_argument("--follow", "-f", action="store_true",
                   help="keep printing new messages as they cross the wire")
    p.add_argument("--limit", type=int, default=25)
    p.add_argument("--width", type=int, default=54)
    p.set_defaults(fn=cmd_chat)
    p = s.add_parser("tone")
    p.add_argument("label")
    p.add_argument("text", nargs="*", default=None,
                   help="omit to print the current tone, give words to set it")
    p.add_argument("--styles", default=None,
                   help="preferred lexicon styles for this peer: --styles feral,annoying")
    p.add_argument("--clear", action="store_true")
    p.set_defaults(fn=cmd_tone)
    p = s.add_parser("inbox")
    p.add_argument("--all", action="store_true")
    p.set_defaults(fn=cmd_inbox)
    p = s.add_parser("read")
    p.add_argument("id")
    p.set_defaults(fn=cmd_read)
    p = s.add_parser("ack")
    p.add_argument("id")
    p.set_defaults(fn=cmd_ack)
    p = s.add_parser("reach")
    p.add_argument("--to", default="")
    p.set_defaults(fn=cmd_reach)
    p = s.add_parser("send")
    p.add_argument("--to", required=True)
    p.add_argument("--body", default=None,
                   help="message text. Prefer --body-file for prose: a body on "
                        "the command line is shell-expanded before we ever see it, "
                        "so a literal $(cat file) in the text is executed and "
                        "replaced by nothing, and trailing blank lines are stripped")
    p.add_argument("--body-file", default=None, metavar="PATH",
                   help="read the body from PATH as UTF-8, byte for byte (use - for stdin)")
    p.add_argument("--session", default=None,
                   help="name of THIS session; auto-derived from the harness if omitted")
    p.add_argument("--to-session", default="", help="only deliver to this session name")
    p.set_defaults(fn=cmd_send)
    a, extra = ap.parse_known_args()
    # `lexicon add --kind names some free words`: options first, phrase last.
    # argparse cannot always split two positionals, so take what is left over.
    if extra:
        if hasattr(a, "text") and a.text is not None:
            a.text = list(a.text) + list(extra)
        else:
            ap.error(f"unrecognized arguments: {' '.join(extra)}")
    # The status is part of the output: a mismatch that only prints is one somebody
    # scrolls past, and a script or another agent reads the code, not the prose.
    rc = a.fn(a)
    if isinstance(rc, int):
        sys.exit(rc)


if __name__ == "__main__":
    main()


