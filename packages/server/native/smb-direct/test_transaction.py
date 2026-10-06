"""Owned temporary directories and a network-free handle server exercise recovery.

This double tests client ordering and refusal; it cannot establish NAS enforcement.
"""

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import patch

from protocol import SmbError
from transport import DirectTransport, SmbProtocolBackend

try:
    from journal import Journal, pending_transactions
    from transaction import Transaction
except ImportError:
    Journal = Transaction = None

ENDPOINT = dict(
    server="nas.local",
    port=445,
    share="test",
    folder="library",
    requireEncryption=False,
)
CREDS = dict(username="test", password="never-log", domain="")
DEST = "22222222-2222-4222-8222-222222222222"
DEVICE = "33333333-3333-4333-8333-333333333333"
MEETING = "44444444-4444-4444-8444-444444444444"
REVISION = "55555555-5555-4555-8555-555555555555"
LIBRARY = "66666666-6666-4666-8666-666666666666"
PHYSICAL = "77777777-7777-4777-8777-777777777777"
PREFIX = f"meetings/{MEETING}/revisions/{REVISION}"
MANIFEST = PREFIX + "/manifest.json"
MARKER = f"commits/{DEVICE}/{REVISION}.json"


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


class MemoryServer:
    """A shared namespace with handle-bound identities and explicit fault points."""

    def __init__(self):
        self.server_guid = "0123456789abcdef0123456789abcdef"
        self.share_safe = self.enforced = True
        self.read_only = False
        self.nodes = {}
        self.handles = []
        self.events = []
        self.fault = None
        self.sequence = 0
        self.add("", directory=True)
        self.add("library", directory=True)
        self.add(
            "library/heed-library.json",
            encoded(dict(format="heed-portable-library", schemaVersion=3, destinationId=DEST)),
        )

    def add(self, path, data=b"", directory=False):
        self.sequence += 1
        n = dict(
            objectId=f"{self.sequence:016x}",
            created="01db000000000001",
            volumeSerial="00000001",
            volumeCreated="01db000000000002",
            directory=directory,
            reparse=False,
            deletePending=False,
            links=1,
            bytes=len(data),
            data=data,
        )
        self.nodes[path] = n
        return n

    def connect(self, *args):
        return dict(authenticated=True, dialect="3.1.1", signed=True, encrypted=False)

    def root_access(self, path):
        return dict(
            readOnly=self.read_only,
            metadata={k: v for k, v in self.nodes[path].items() if k != "data"},
        )

    def open(self, path, directory=False, access="read", exclusive=False, verification=False):
        if exclusive:
            if path in self.nodes:
                raise SmbError("destination-exists")
            node = self.add(path, directory=directory)
            self.events.append(("create", path))
        else:
            if path not in self.nodes:
                raise FileNotFoundError(path)
            node = self.nodes[path]
        if self.enforced:
            for h in self.handles:
                if (
                    not h.closed
                    and h.node is node
                    and (access != "read" or h.access != "read" and not verification)
                ):
                    raise SmbError("destination-busy")
        h = SimpleNamespace(path=path, node=node, access=access, directory=directory, closed=False)
        self.handles.append(h)
        return h

    def metadata(self, h):
        if h.closed:
            raise AssertionError("closed handle used")
        return {k: v for k, v in h.node.items() if k != "data"}

    def enforce_sharing(self, h):
        return self.enforced

    def list(self, h, limit):
        prefix = h.path + "/" if h.path else ""
        return iter(
            sorted(
                p[len(prefix) :]
                for p in self.nodes
                if p.startswith(prefix) and p != h.path and "/" not in p[len(prefix) :]
            )
        )

    def read(self, h, offset, size):
        return h.node["data"][offset : offset + size]

    def write(self, h, data, offset):
        h.node["data"] = h.node["data"][:offset] + data + h.node["data"][offset + len(data) :]
        h.node["bytes"] = len(h.node["data"])
        return len(data)

    def flush(self, h):
        self.events.append(("flush", h.path))
        if self.fault == "flush":
            self.fault = None
            raise SmbError()

    def rename(self, h, target):
        if target in self.nodes:
            raise SmbError("destination-exists")
        old = h.path
        moves = [p for p in self.nodes if p == old or p.startswith(old + "/")]
        for p in moves:
            self.nodes[target + p[len(old) :]] = self.nodes.pop(p)
        for opened in self.handles:
            if opened.path == old or opened.path.startswith(old + "/"):
                opened.path = target + opened.path[len(old) :]
        self.events.append(("rename", old, target))
        if self.fault == "rename" or self.fault == target:
            self.fault = None
            raise SmbError()

    def disposition(self,h):
        if h.closed or h.access != "delete":raise AssertionError("unowned disposition")
        h.node["deletePending"]=True
        self.events.append(("disposition",h.path))
        if self.fault=="disposition":
            self.fault=None
            raise SmbError()

    def close_handle(self, h):
        h.closed = True
        self.events.append(("close", h.path))
        if h.node["deletePending"] and self.fault != "pending" and not any(not other.closed and other.node is h.node for other in self.handles):
            if self.nodes.get(h.path) is h.node:del self.nodes[h.path]
        if self.fault == "delete-close" and h.node["deletePending"]:
            self.fault=None
            raise SmbError()
        if self.fault == "close" or self.fault == ("close", h.path):
            self.fault = None
            raise SmbError()

    def close(self):
        for h in self.handles:
            if not h.closed:
                self.close_handle(h)


class MemorySession:
    """Each production transport owns only its session's opens on the shared server."""

    def __init__(self, server):
        self.server = server
        self.owned = []

    def __getattr__(self, name):
        return getattr(self.server, name)

    def open(self, *args, **kwargs):
        h = self.server.open(*args, **kwargs)
        self.owned.append(h)
        return h

    def close(self):
        for h in reversed(self.owned):
            if not h.closed:
                self.server.close_handle(h)


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Transaction, "original-owner transaction engine is not implemented")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = str(Path(self.temp.name).resolve())
        self.physical = patch("journal.physical_uuid", return_value=PHYSICAL)
        self.physical.start()
        self.addCleanup(self.physical.stop)
        self.server = MemoryServer()
        self.binding = dict(
            id=str(uuid4()),
            name="Synthetic",
            endpoint=ENDPOINT,
            identity=dict(
                serverGuid=self.server.server_guid,
                volumeSerial="00000001",
                volumeCreated="01db000000000002",
                rootId="0000000000000002",
                rootCreated="01db000000000001",
            ),
            destinationId=DEST,
            destinationVersion=3,
            connectionGeneration=str(uuid4()),
            credentialRef=str(uuid4()),
            readOnly=False,
            security="signed",
        )
        self.context = dict(operationId=str(uuid4()), deviceId=DEVICE, kind="publish")
        self.transactions = []
        self.addCleanup(lambda: [t.abort() for t in self.transactions])

    def transaction(self, context=None, app=None):
        tx = Transaction(
            DirectTransport(ENDPOINT, CREDS, MemorySession(self.server)),
            self.binding,
            context or self.context,
            app or self.app,
        )
        self.transactions.append(tx)
        return tx

    def bundle(self, audio=False):
        payload = dict(
            schemaVersion=1,
            meetingId=MEETING,
            title="Synthetic",
            createdAt="2026-10-06T00:00:00Z",
            duration=1,
            language="en",
            transcript="Public fixture.",
            segments=[],
            speakers=[],
            tags=[],
            aiNotes="",
            summary="",
            pinned=False,
            transcriptFinalized=True,
        )
        media = b"synthetic audio"
        if audio:
            payload["audio"] = dict(
                sha256=digest(media),
                bytes=len(media),
                format="wav",
                mode="archived",
                objectPath="objects/" + digest(media),
            )
        body = encoded(payload)
        manifest = dict(
            schemaVersion=1,
            libraryId=LIBRARY,
            meetingId=MEETING,
            revisionId=REVISION,
            parents=[],
            artifacts=[dict(path="meeting.json", bytes=len(body), sha256=digest(body))],
        )
        marker = dict(
            schemaVersion=1,
            libraryId=LIBRARY,
            meetingId=MEETING,
            revisionId=REVISION,
            deviceId=DEVICE,
            manifestPath=MANIFEST,
            manifestHash=digest(encoded(manifest)),
        )
        intent = dict(
            version=1,
            id=REVISION,
            deviceId=DEVICE,
            revision=dict(libraryId=LIBRARY, meetingId=MEETING, revisionId=REVISION),
        )
        if audio:
            intent["audio"] = dict(
                path=payload["audio"]["objectPath"],
                bytes=len(media),
                sha256=digest(media),
            )
        return body, encoded(manifest), marker, intent, media

    def write(self, tx, path, data):
        tx.write(path, io.BytesIO(data), len(data), digest(data))

    def publish(self, tx, audio=True):
        body, manifest, marker, intent, media = self.bundle(audio)
        self.write(tx, MANIFEST, manifest)
        tx.write_pending(intent)
        if audio:
            self.write(tx, intent["audio"]["path"], media)
        self.write(tx, PREFIX + "/meeting.json", body)
        self.write(tx, MARKER, encoded(marker))
        return marker, intent

    def deletion_fixture(self):
        publication = self.transaction()
        marker, intent_value = self.publish(publication, audio=False)
        publication.confirm(marker)
        publication.retire_pending(intent_value)
        publication.checkpoint()
        publication.close()
        self.context = dict(self.context, operationId=str(uuid4()), kind="delete")
        tx = self.transaction()
        tx.inventory()
        body, manifest_data, _, _, _ = self.bundle(False)
        record = dict(version=1, jobId=self.context["operationId"], destinationId=DEST,
                      revisions=[dict(libraryId=LIBRARY,meetingId=MEETING,revisionId=REVISION,manifestHash=digest(manifest_data),parents=[])],
                      artifacts=[dict(path=p,bytes=len(b),sha256=digest(b)) for p,b in ((MARKER,encoded(marker)),(PREFIX+"/meeting.json",body),(MANIFEST,manifest_data))])
        return tx, record

    def test_exact_deletion_requires_original_receipt_and_permanent_verified_barrier(self):
        tx, record = self.deletion_fixture()
        self.assertTrue(callable(getattr(tx, "remove_exact", None)), "exact deletion missing")
        with self.assertRaises(SmbError):
            tx.remove_exact(record["jobId"],record["artifacts"][0])
        tx.write_deletion(record)
        for item in record["artifacts"]:
            self.assertEqual(tx.remove_exact(record["jobId"],item), "removed")
            self.assertNotIn("library/"+item["path"],self.server.nodes)
            self.assertEqual(tx.remove_exact(record["jobId"],item), "already-removed")
        self.assertIn("library/control/deletions/"+record["jobId"]+".json",self.server.nodes)

    def test_unknown_same_bytes_after_receipt_never_gets_removed(self):
        tx, record = self.deletion_fixture()
        self.assertTrue(callable(getattr(tx, "remove_exact", None)), "exact deletion missing")
        tx.write_deletion(record)
        item=record["artifacts"][0];path="library/"+item["path"]
        unknown=self.server.add(path,self.server.nodes[path]["data"])
        with self.assertRaises(SmbError):tx.remove_exact(record["jobId"],item)
        self.assertIs(self.server.nodes[path],unknown)
        self.assertFalse(any(e[0]=="disposition" for e in self.server.events))

    def test_exact_deletion_refuses_changed_parent_multi_link_or_failed_barrier(self):
        for fault in ("parent","links","fence"):
            with self.subTest(fault=fault):
                self.server=MemoryServer();self.context=dict(self.context,operationId=str(uuid4()),kind="publish");tx,record=self.deletion_fixture()
                self.assertTrue(callable(getattr(tx,"remove_exact",None)),"exact deletion missing")
                tx.write_deletion(record);item=record["artifacts"][0]
                if fault=="parent":self.server.add("library/commits/"+DEVICE,directory=True)
                elif fault=="links":self.server.nodes["library/"+item["path"]]["links"]=2
                else:self.server.nodes["library/control/deletions/"+record["jobId"]+".json"]["data"]=b"changed"
                with self.assertRaises(SmbError):tx.remove_exact(record["jobId"],item)
                self.assertIn("library/"+item["path"],self.server.nodes)
                self.assertFalse(any(e[0]=="disposition" for e in self.server.events))

    def test_changed_selected_grandparent_refuses_exact_deletion_before_disposition(self):
        tx,record=self.deletion_fixture();tx.write_deletion(record)
        self.server.add("library/meetings/"+MEETING,directory=True)
        with self.assertRaises(SmbError):tx.remove_exact(record["jobId"],record["artifacts"][1])
        self.assertFalse(any(e[0]=="disposition" for e in self.server.events))

    def test_delete_pending_and_lost_set_or_close_ack_retain_original_job_until_absence(self):
        for fault in ("pending","disposition","delete-close"):
            with self.subTest(fault=fault):
                self.server=MemoryServer();self.context=dict(self.context,operationId=str(uuid4()),kind="publish");tx,record=self.deletion_fixture()
                self.assertTrue(callable(getattr(tx,"remove_exact",None)),"exact deletion missing")
                tx.write_deletion(record);self.server.fault=fault;item=record["artifacts"][0]
                with self.assertRaises(SmbError):tx.remove_exact(record["jobId"],item)
                with self.assertRaises(SmbError):tx.checkpoint()
                self.assertTrue(any(job["operationId"]==record["jobId"] for job in pending_transactions(self.binding,self.app)))
                tx.abort();self.server.fault=None
                if fault=="pending":
                    # The server may complete its own pending disposition later; client never unlinks.
                    self.assertTrue(self.server.nodes["library/"+item["path"]]["deletePending"])
                    del self.server.nodes["library/"+item["path"]]
                recovered=self.transaction()
                self.assertEqual(recovered.remove_exact(record["jobId"],item),"already-removed")

    def test_failed_permanent_barrier_ack_cannot_authorize_disposition(self):
        tx,record=self.deletion_fixture()
        self.server.fault="library/control/deletions/"+record["jobId"]+".json"
        with self.assertRaises(SmbError):tx.write_deletion(record)
        with self.assertRaises(SmbError):tx.remove_exact(record["jobId"],record["artifacts"][0])
        self.assertFalse(any(e[0]=="disposition" for e in self.server.events))
        tx.write_deletion(record)
        self.assertEqual(tx.remove_exact(record["jobId"],record["artifacts"][0]),"removed")

    def test_incomplete_target_record_refuses_before_permanent_barrier_publication(self):
        tx,record=self.deletion_fixture();item=record["artifacts"][0]
        del self.server.nodes["library/"+item["path"]]
        with self.assertRaises((SmbError,FileNotFoundError)):tx.write_deletion(record)
        self.assertNotIn("library/control/deletions/"+record["jobId"]+".json",self.server.nodes)
        self.assertFalse(any(e[0]=="disposition" for e in self.server.events))

    def test_prepared_zero_effect_original_job_remains_recoverable_after_auth_failure(self):
        connect=self.server.connect
        self.server.connect=lambda *args:(_ for _ in ()).throw(SmbError("access-denied"))
        with self.assertRaises(SmbError):self.transaction()
        job=pending_transactions(self.binding,self.app)[0]
        self.assertTrue(job["recoverable"],"original prepared zero-effect authority must be retryable")
        self.assertTrue(job["releaseOnly"])
        self.assertEqual(self.server.events,[])
        self.server.connect=connect
        recovered=self.transaction();recovered.checkpoint();recovered.close()
        self.assertEqual(pending_transactions(self.binding,self.app),[])

    def test_prepared_zero_effect_query_never_adopts_copied_or_substituted_authority(self):
        self.server.enforced=False
        with self.assertRaises(SmbError):self.transaction()
        self.server.enforced=True
        copied=self.app+"-prepared-copy";shutil.copytree(self.app,copied)
        self.addCleanup(lambda:shutil.rmtree(copied,ignore_errors=True))
        self.assertFalse(pending_transactions(self.binding,copied)[0]["recoverable"])
        guard=next(Path(self.app).rglob("*.guard"));guard.unlink();guard.write_bytes(b"");guard.chmod(0o600)
        self.assertFalse(pending_transactions(self.binding,self.app)[0]["recoverable"])

    def test_prepared_zero_effect_exception_refuses_recorded_intent_or_effect(self):
        journal=Journal(self.binding,self.context,self.app)
        original=copy.deepcopy(journal.data)
        cases=[
            {"effects":1},
            {"claim":dict(stage=".heed-stage-"+self.context["operationId"],metadata=None,state="allocating")},
            {"allocations":{"objects/"+"a"*64:dict(stage=".heed-claim/"+self.context["operationId"],metadata=None,bytes=0,sha256="a"*64,state="planned",directory=False)}},
            {"confirmed":{"commits/"+DEVICE+"/"+self.context["operationId"]+".json":"a"*64}},
        ]
        try:
            for changes in cases:
                with self.subTest(changes=changes):
                    journal.data=copy.deepcopy(original);journal.data.update(changes);journal.save()
                    self.assertFalse(pending_transactions(self.binding,self.app)[0]["recoverable"])
        finally:journal.close()

    def test_atomic_job_copy_uses_quota_sibling_name_and_is_never_recovery_authority(self):
        tx=self.transaction();tx.journal.data["effects"]=1
        with patch("journal.os.replace",side_effect=OSError("owned synthetic replace fault")):
            with self.assertRaises(OSError):tx.journal.save()
        folder=Path(tx.journal.path);copies=list(folder.glob(self.context["operationId"]+".json.*.tmp"))
        self.assertEqual(len(copies),1)
        self.assertEqual(json.loads(copies[0].read_text())["effects"],1)
        tx.abort();recovered=self.transaction()
        self.assertEqual(recovered.journal.data["effects"],0)
        self.assertTrue(copies[0].exists())

    def large_quota_journal(self):
        tx=self.transaction()
        tx.journal.data["allocations"]={
            "objects/"+format(index,"064x"):dict(stage=".heed-claim/"+str(uuid4()),metadata=None,bytes=0,sha256="a"*64,state="planned",directory=False)
            for index in range(10000)
        }
        tx.journal.save()
        primary=Path(tx.journal.path)/tx.journal.name
        self.assertGreater(primary.stat().st_size,2666666)
        return tx,primary

    def test_journal_quota_retained_failed_copy_refuses_same_uuid_retry_before_growth(self):
        tx,primary=self.large_quota_journal()
        original=primary.read_bytes()
        with patch("journal.os.replace",side_effect=OSError("owned replacement failure")):
            with self.assertRaises(OSError):tx.journal.save()
        copies=list(primary.parent.glob(primary.name+".*.tmp"))
        self.assertEqual(len(copies),1)
        self.assertEqual(copies[0].read_bytes(),original)
        before={p.name:p.stat().st_size for p in primary.parent.iterdir()}
        tx.abort()
        with self.assertRaises(SmbError) as refused:self.transaction()
        self.assertEqual(refused.exception.code,"bounds-exceeded")
        self.assertEqual({p.name:p.stat().st_size for p in primary.parent.iterdir()},before)
        self.assertEqual(primary.read_bytes(),original)
        self.assertTrue(pending_transactions(self.binding,self.app)[0]["recoverable"])

    def test_journal_quota_exact_aggregate_boundary_admits_then_refuses_one_extra_byte(self):
        tx,primary=self.large_quota_journal()
        original=primary.read_bytes()
        retained=primary.with_name(primary.name+"."+str(uuid4())+".tmp")
        retained.write_bytes(b"");retained.chmod(0o600)
        with retained.open("r+b") as stream:stream.truncate(8000000-2*len(original))
        tx.journal.save()
        self.assertTrue(retained.exists())
        self.assertEqual(primary.read_bytes(),original)
        with retained.open("r+b") as stream:stream.truncate(retained.stat().st_size+1)
        before={p.name:p.stat().st_size for p in primary.parent.iterdir()}
        with self.assertRaises(SmbError) as refused:tx.journal.save()
        self.assertEqual(refused.exception.code,"bounds-exceeded")
        self.assertEqual({p.name:p.stat().st_size for p in primary.parent.iterdir()},before)
        self.assertEqual(primary.read_bytes(),original)

    def test_journal_quota_refuses_unsafe_siblings_without_blocking_or_removing_evidence(self):
        tx=self.transaction();primary=Path(tx.journal.path)/tx.journal.name
        for kind in ("fifo","symlink","multiple-links"):
            with self.subTest(kind=kind):
                sibling=primary.with_name(primary.name+"."+str(uuid4())+".tmp")
                if kind=="fifo":os.mkfifo(sibling,0o600)
                elif kind=="symlink":sibling.symlink_to(primary)
                else:os.link(primary,sibling)
                before={p.name for p in primary.parent.iterdir()}
                try:
                    with self.assertRaises(SmbError):tx.journal.save()
                    self.assertEqual({p.name for p in primary.parent.iterdir()},before)
                    self.assertTrue(sibling.exists() or sibling.is_symlink())
                finally:sibling.unlink()

    def test_journal_quota_entry_scan_stops_before_materializing_excess_names(self):
        tx=self.transaction();seen=[]
        class Entries:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def __iter__(self):
                for index in range(20):
                    seen.append(index)
                    yield SimpleNamespace(name="unrelated-"+str(index))
                raise AssertionError("unbounded directory enumeration")
        with patch("journal.MAX_ENTRIES",10),patch("journal.os.scandir",return_value=Entries()):
            with self.assertRaises(SmbError) as refused:tx.journal.save()
        self.assertEqual(refused.exception.code,"bounds-exceeded")
        self.assertEqual(len(seen),20)

    def test_exact_deletion_record_rejects_unrelated_revision_before_effects(self):
        tx,record=self.deletion_fixture()
        record["revisions"][0]["revisionId"]=str(uuid4())
        before=list(self.server.events)
        with self.assertRaises(SmbError):tx.write_deletion(record)
        self.assertEqual(self.server.events,before)

    def test_guardian_exact_deletion_frames_and_canonical_fence_complete_owned_job(self):
        from guardian import serve
        tx,record=self.deletion_fixture();tx.abort()
        canonical_fence=dict(kind="heed-deleted-revision",version=1,jobId=record["jobId"],destinationId=DEST,revision=record["revisions"][0],artifact=record["artifacts"][-1])
        requests=[dict(action="write-deletion",value=record)]
        requests += [dict(action="remove-exact",jobId=record["jobId"],artifact=a) for a in record["artifacts"]]
        requests += [dict(action="write-fence",value=canonical_fence),dict(action="checkpoint"),dict(action="close")]
        startup=dict(protocol=1,action="transaction",endpoint=ENDPOINT,credentials=CREDS,binding=self.binding,context=self.context,appDir=self.app)
        wire=encoded(startup)+b"\n"+b"".join(encoded(dict(id=i+1,nonce=f"{i+1:064x}",**r))+b"\n" for i,r in enumerate(requests))
        output=io.BytesIO();serve(io.BytesIO(wire),output,backend_factory=lambda:MemorySession(self.server))
        responses=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(all(r["ok"] for r in responses),responses)
        self.assertEqual([r["value"] for r in responses[2:5]],["removed"]*3)
        self.assertEqual(json.loads(self.server.nodes["library/"+MANIFEST]["data"]),canonical_fence)
        self.assertEqual(pending_transactions(self.binding,self.app),[])

    def test_delete_handle_denies_competing_write_and_delete_without_delete_on_open(self):
        tx,record=self.deletion_fixture()
        self.assertTrue(callable(getattr(tx,"remove_exact",None)),"exact deletion missing")
        tx.write_deletion(record);item=record["artifacts"][0]
        self.assertFalse(self.server.nodes["library/"+item["path"]]["deletePending"])
        for access in ("write","delete"):
            with self.assertRaises(SmbError):self.server.open("library/"+item["path"],access=access)
        self.assertEqual(tx.remove_exact(record["jobId"],item),"removed")

    def test_observation_digest_changes_for_equal_bytes_replacement_and_stable_scans_match(self):
        tx,record=self.deletion_fixture()
        self.assertTrue(callable(getattr(tx,"observation_digest",None)),"observation digest missing")
        first=tx.observation_digest();self.assertEqual(first,tx.observation_digest())
        tx.checkpoint();tx.close()
        item=record["artifacts"][0];p="library/"+item["path"];self.server.add(p,self.server.nodes[p]["data"])
        self.context["operationId"]=str(uuid4());current=self.transaction();current.inventory()
        self.assertNotEqual(first,current.observation_digest())

    def test_complete_publication_confirm_checkpoint_and_whole_claim_release(self):
        tx = self.transaction()
        marker, intent = self.publish(tx)
        self.assertEqual(tx.confirm(marker), "remote-confirmed")
        tx.retire_pending(intent)
        self.assertEqual(tx.inventory()["pending"], [])
        tx.checkpoint()
        tx.close()
        self.assertNotIn("library/.heed-claim", self.server.nodes)
        self.assertEqual(pending_transactions(self.binding, self.app), [])
        canonical = [e[2] for e in self.server.events if e[0] == "rename"]
        self.assertLess(
            canonical.index("library/" + MANIFEST),
            canonical.index("library/objects/" + digest(b"synthetic audio")),
        )
        self.assertLess(
            canonical.index("library/" + PREFIX + "/meeting.json"),
            canonical.index("library/" + MARKER),
        )

    def test_competing_owner_and_old_timestamp_never_take_over(self):
        tx = self.transaction()
        tx.abort()
        other = dict(self.context, operationId=str(uuid4()))
        with self.assertRaises(SmbError):
            self.transaction(other)
        self.assertIn("library/.heed-claim", self.server.nodes)
        resumed = self.transaction()
        resumed.checkpoint()
        resumed.close()

    def test_manifest_first_and_pending_audio_admission(self):
        tx = self.transaction()
        body, manifest, marker, intent, media = self.bundle(True)
        for path, data in [
            (PREFIX + "/meeting.json", body),
            (intent["audio"]["path"], media),
            (MARKER, encoded(marker)),
        ]:
            with self.assertRaises(SmbError):
                self.write(tx, path, data)
            self.assertNotIn("library/" + path, self.server.nodes)
        self.write(tx, MANIFEST, manifest)
        with self.assertRaises(SmbError):
            self.write(tx, intent["audio"]["path"], media)

    def test_unknown_equal_manifest_is_not_adopted_or_overwritten(self):
        tx = self.transaction()
        _, manifest, *_ = self.bundle()
        self.server.add("library/meetings", directory=True)
        self.server.add("library/meetings/" + MEETING, directory=True)
        self.server.add("library/meetings/" + MEETING + "/revisions", directory=True)
        self.server.add("library/" + PREFIX, directory=True)
        unknown = self.server.add("library/" + MANIFEST, manifest)
        with self.assertRaises(SmbError):
            self.write(tx, MANIFEST, manifest)
        self.assertIs(self.server.nodes["library/" + MANIFEST], unknown)

    def test_marker_rejected_until_payload_and_audio_readback_match(self):
        tx = self.transaction()
        body, manifest, marker, intent, media = self.bundle(True)
        self.write(tx, MANIFEST, manifest)
        tx.write_pending(intent)
        self.write(tx, PREFIX + "/meeting.json", body)
        with self.assertRaises(SmbError):
            self.write(tx, MARKER, encoded(marker))
        self.assertNotIn("library/" + MARKER, self.server.nodes)
        self.write(tx, intent["audio"]["path"], media)
        self.server.nodes["library/" + intent["audio"]["path"]]["data"] = b"x" * len(media)
        with self.assertRaises(SmbError):
            self.write(tx, MARKER, encoded(marker))

    def test_lost_rename_ack_retains_receipt_and_original_can_resume(self):
        tx = self.transaction()
        _, manifest, *_ = self.bundle()
        self.server.fault = "library/" + MANIFEST
        with self.assertRaises(SmbError):
            self.write(tx, MANIFEST, manifest)
        original = self.server.nodes["library/" + MANIFEST]
        tx.abort()
        resumed = self.transaction()
        self.write(resumed, MANIFEST, manifest)
        self.assertIs(self.server.nodes["library/" + MANIFEST], original)

    def test_lost_flush_ack_never_exposes_partial_marker(self):
        tx = self.transaction()
        _, manifest, *_ = self.bundle()
        self.server.fault = "flush"
        with self.assertRaises(SmbError):
            self.write(tx, MANIFEST, manifest)
        self.assertNotIn("library/" + MANIFEST, self.server.nodes)
        tx.abort()
        self.assertTrue(pending_transactions(self.binding, self.app))

    def test_copied_journal_and_guard_never_grant_ownership(self):
        tx = self.transaction()
        tx.abort()
        with tempfile.TemporaryDirectory() as copied:
            shutil.copytree(self.app, copied, dirs_exist_ok=True)
            query = pending_transactions(self.binding, str(Path(copied).resolve()))
            self.assertFalse(query[0]["recoverable"])
            with self.assertRaises(SmbError):
                self.transaction(app=str(Path(copied).resolve()))
        self.assertIn("library/.heed-claim", self.server.nodes)

    def test_wrong_physical_host_and_generation_preserve_job(self):
        tx = self.transaction()
        tx.abort()
        with patch("journal.physical_uuid", return_value=str(uuid4())):
            self.assertFalse(pending_transactions(self.binding, self.app)[0]["recoverable"])
            with self.assertRaises(SmbError):
                self.transaction()
        changed = dict(self.binding, connectionGeneration=str(uuid4()))
        self.assertFalse(pending_transactions(changed, self.app)[0]["recoverable"])

    def test_lost_release_ack_only_reconciles_owned_archived_claim(self):
        tx = self.transaction()
        tx.checkpoint()
        released = "library/.heed-released-" + self.context["operationId"]
        self.server.fault = released
        with self.assertRaises(SmbError):
            tx.close()
        tx.abort()
        later = self.server.add("library/.heed-claim", directory=True)
        resumed = self.transaction()
        resumed.checkpoint()
        resumed.close()
        self.assertIs(self.server.nodes["library/.heed-claim"], later)
        self.assertEqual(pending_transactions(self.binding, self.app), [])

    def test_close_ack_failure_preserves_claim_and_checkpoint(self):
        tx = self.transaction()
        self.publish(tx)
        tx.checkpoint()
        self.server.fault = "close"
        with self.assertRaises(SmbError):
            tx.close()
        self.assertIn("library/.heed-claim", self.server.nodes)
        self.assertTrue(pending_transactions(self.binding, self.app))

    def test_changed_ancestor_or_unsupported_sharing_has_no_publication_effect(self):
        tx = self.transaction()
        _, manifest, *_ = self.bundle()
        self.server.nodes["library"]["objectId"] = "000000000000ffff"
        with self.assertRaises(SmbError):
            self.write(tx, MANIFEST, manifest)
        self.assertNotIn("library/" + MANIFEST, self.server.nodes)
        tx.abort()
        self.server = MemoryServer()
        self.server.enforced = False
        with self.assertRaises(SmbError):
            self.transaction(dict(self.context, operationId=str(uuid4())))

    def test_incomplete_unknown_marker_never_enters_complete_inventory(self):
        tx = self.transaction()
        self.server.add("library/commits", directory=True)
        self.server.add("library/commits/" + DEVICE, directory=True)
        self.server.add("library/" + MARKER, b"{")
        with self.assertRaises(SmbError):
            tx.inventory()

    def test_cancel_without_checkpoint_retains_original_claim_and_pending(self):
        tx = self.transaction()
        self.publish(tx)
        tx.abort()
        self.assertIn("library/.heed-claim", self.server.nodes)
        self.assertTrue(pending_transactions(self.binding, self.app)[0]["recoverable"])

    def test_stream_wrong_length_or_digest_never_publishes(self):
        tx = self.transaction()
        _, manifest, *_ = self.bundle()
        with self.assertRaises(SmbError):
            tx.write(MANIFEST, io.BytesIO(manifest[:-1]), len(manifest), digest(manifest))
        self.assertNotIn("library/" + MANIFEST, self.server.nodes)

    def test_pure_pending_query_has_no_creation_effects(self):
        before = sorted(Path(self.app).rglob("*"))
        self.assertEqual(pending_transactions(self.binding, self.app), [])
        self.assertEqual(sorted(Path(self.app).rglob("*")), before)

    def test_permanent_deletion_intent_refuses_manifest_before_transfer(self):
        tx = self.transaction(dict(self.context, kind="delete"))
        body, manifest_data, marker_value, _, _ = self.bundle()
        record = dict(
            version=1,
            jobId=self.context["operationId"],
            destinationId=DEST,
            revisions=[
                dict(
                    libraryId=LIBRARY,
                    meetingId=MEETING,
                    revisionId=REVISION,
                    manifestHash=digest(manifest_data),
                    parents=[],
                )
            ],
            artifacts=[
                dict(
                    path=MANIFEST,
                    bytes=len(manifest_data),
                    sha256=digest(manifest_data),
                )
            ],
        )
        self.server.add("library/meetings",directory=True)
        self.server.add("library/meetings/"+MEETING,directory=True)
        self.server.add("library/meetings/"+MEETING+"/revisions",directory=True)
        self.server.add("library/"+PREFIX,directory=True)
        self.server.add("library/"+MANIFEST,manifest_data)
        tx.write_deletion(record)
        tx.checkpoint()
        tx.close()
        self.context["operationId"] = str(uuid4())
        publication = self.transaction()
        with self.assertRaises(SmbError):
            self.write(publication, MANIFEST, manifest_data)
        self.assertEqual(self.server.nodes["library/"+MANIFEST]["data"],manifest_data)

    def test_missing_allocation_receipt_never_adopts_remote_stage(self):
        tx = self.transaction()
        _, manifest_data, *_ = self.bundle()
        self.server.fault = "library/" + MANIFEST
        with self.assertRaises(SmbError):
            self.write(tx, MANIFEST, manifest_data)
        tx.journal.data["allocations"][MANIFEST]["metadata"] = None
        tx.journal.save()
        tx.abort()
        self.assertFalse(pending_transactions(self.binding, self.app)[0]["recoverable"])
        resumed = self.transaction()
        with self.assertRaises(SmbError):
            self.write(resumed, MANIFEST, manifest_data)

    def test_directory_rename_ack_loss_resumes_without_unknown_allocation(self):
        tx = self.transaction()
        _, manifest_data, *_ = self.bundle()
        self.server.fault = "library/meetings"
        with self.assertRaises(SmbError):
            self.write(tx, MANIFEST, manifest_data)
        tx.abort()
        pending = pending_transactions(self.binding, self.app)
        self.assertEqual(
            pending[0]["admissions"],
            [
                dict(
                    meetingId=MEETING,
                    revisionId=REVISION,
                    manifestHash=digest(manifest_data),
                )
            ],
        )
        self.assertTrue(pending[0]["recoverable"])
        resumed = self.transaction()
        self.write(resumed, MANIFEST, manifest_data)
        resumed.checkpoint()
        resumed.close()
        self.assertEqual(pending_transactions(self.binding, self.app), [])

    def test_pending_guard_replacement_is_not_original_authority(self):
        tx = self.transaction()
        tx.abort()
        guards = list(Path(self.app).rglob("*.guard"))
        self.assertEqual(len(guards), 1)
        data = guards[0].read_bytes()
        guards[0].unlink()
        guards[0].write_bytes(data)
        guards[0].chmod(0o600)
        self.assertFalse(pending_transactions(self.binding, self.app)[0]["recoverable"])

    def test_operation_handle_bound_refuses_before_unbounded_open(self):
        tx = self.transaction()
        with patch("transaction.MAX_HANDLES", len(tx.transport.pins) + len(tx.handles)):
            with self.assertRaises(SmbError):
                tx.open_handle("unknown")
        self.assertNotIn("library/unknown", self.server.nodes)

    def test_credential_free_pending_rpc_never_connects(self):
        from guardian import serve

        tx = self.transaction()
        tx.abort()
        startup = dict(protocol=1, action="pending", binding=self.binding, appDir=self.app)
        output = io.BytesIO()
        serve(
            io.BytesIO(encoded(startup) + b"\n"),
            output,
            backend_factory=lambda: self.fail("pending query must not connect"),
        )
        response = json.loads(output.getvalue())
        self.assertTrue(response["ok"])
        self.assertTrue(response["value"][0]["recoverable"])
        self.assertNotIn("serverGuid", output.getvalue().decode())
        self.assertNotIn(PHYSICAL, output.getvalue().decode())

    def test_guardian_publication_frames_echo_current_nonce_and_complete_readback(self):
        from guardian import serve

        body, manifest_data, marker_value, intent_value, media = self.bundle(False)
        startup = dict(
            protocol=1,
            action="transaction",
            endpoint=ENDPOINT,
            credentials=CREDS,
            binding=self.binding,
            context=self.context,
            appDir=self.app,
        )
        requests = [
            ("inventory", {}),
            (
                "write",
                dict(
                    path=MANIFEST,
                    bytes=len(manifest_data),
                    sha256=digest(manifest_data),
                ),
            ),
            ("write-pending", dict(value=intent_value)),
            (
                "write",
                dict(path=PREFIX + "/meeting.json", bytes=len(body), sha256=digest(body)),
            ),
            (
                "write",
                dict(
                    path=MARKER,
                    bytes=len(encoded(marker_value)),
                    sha256=digest(encoded(marker_value)),
                ),
            ),
            ("confirm", dict(commit=marker_value)),
            ("checkpoint", {}),
            ("close", {}),
        ]
        wire = encoded(startup) + b"\n"
        bodies = {2: manifest_data, 4: body, 5: encoded(marker_value)}
        for index, (action, value) in enumerate(requests, 1):
            wire += (
                encoded(dict(id=index, nonce=f"{index:064x}", action=action, **value))
                + b"\n"
                + bodies.get(index, b"")
            )
        output = io.BytesIO()
        serve(io.BytesIO(wire), output, backend_factory=lambda: self.server)
        frames = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(frames[0].get("ready"), frames)
        terminals = []
        for frame in frames[1:]:
            self.assertEqual(frame["nonce"], f"{frame['id']:064x}")
            if "ok" in frame:
                self.assertTrue(frame["ok"], frames)
                terminals.append(frame)
        self.assertEqual(len(terminals), 8)
        self.assertEqual(terminals[5]["value"], "remote-confirmed")
        self.assertNotIn("library/.heed-claim", self.server.nodes)

    def test_readback_reopens_exact_owned_allocation_before_accepting_it(self):
        tx = self.transaction()
        _, manifest_data, *_ = self.bundle()
        original_open = self.server.open
        replaced = False

        def replace_on_read(path, *args, **kwargs):
            nonlocal replaced
            if (
                path == "library/" + MANIFEST
                and path in self.server.nodes
                and not kwargs.get("verification")
                and kwargs.get("access", "read") == "read"
                and not replaced
            ):
                replaced = True
                self.server.add(path, manifest_data)
            return original_open(path, *args, **kwargs)

        self.server.open = replace_on_read
        with self.assertRaises(SmbError):
            self.write(tx, MANIFEST, manifest_data)
        self.assertNotEqual(tx.journal.data["allocations"][MANIFEST]["state"], "published")
        with self.assertRaises(SmbError):
            tx.admission(MANIFEST)

    def test_release_closes_descendants_before_claim_move(self):
        tx = self.transaction()
        self.publish(tx)
        tx.checkpoint()
        tx.close()
        release = next(
            i
            for i, e in enumerate(self.server.events)
            if e[0] == "rename" and e[1] == "library/.heed-claim"
        )
        for h in self.server.handles:
            if h.path.startswith("library/") and not h.path.startswith("library/.heed-released-"):
                closes = [i for i, e in enumerate(self.server.events) if e == ("close", h.path)]
                self.assertTrue(closes)
                self.assertLess(max(closes), release)

    def test_claim_receipt_corruption_is_bounded_recovery_refusal(self):
        tx = self.transaction()
        tx.abort()
        job_path = next(Path(self.app).rglob("*.json"))
        job = json.loads(job_path.read_text())
        job["claim"]["stage"] = "../foreign"
        job_path.write_text(json.dumps(job))
        with self.assertRaises(SmbError):
            pending_transactions(self.binding, self.app)
        with self.assertRaises(SmbError):
            self.transaction()

    def test_fresh_namespace_pin_bound_rejects_excess_without_open(self):
        tx = self.transaction()
        for i in range(8):
            self.server.add("library/d" + str(i), directory=True)
        with patch("transport.MAX_HANDLES", len(tx.transport.pins) + 2):
            tx.transport.pin("d0", True)
            tx.transport.pin("d1", True)
            with self.assertRaises(SmbError):
                tx.transport.pin("d2", True)

    def test_competing_live_session_does_not_close_or_take_over_owner(self):
        tx = self.transaction()
        with self.assertRaises(SmbError):
            self.transaction(dict(self.context, operationId=str(uuid4())))
        self.assertFalse(tx.claim.closed)
        marker_value, _ = self.publish(tx)
        self.assertEqual(tx.confirm(marker_value), "remote-confirmed")
        tx.checkpoint()
        tx.close()

    def test_lost_descendant_close_ack_retains_checkpoint_and_claim(self):
        tx = self.transaction()
        self.publish(tx)
        tx.checkpoint()
        self.server.fault = ("close", "library/" + MARKER)
        with self.assertRaises(SmbError):
            tx.close()
        self.assertIn("library/.heed-claim", self.server.nodes)
        self.assertEqual(tx.journal.data["phase"], "checkpointed")
        tx.abort()
        resumed = self.transaction()
        resumed.close()
        self.assertNotIn("library/.heed-claim", self.server.nodes)

    def test_unsafe_target_identity_refuses_before_immutable_effect(self):
        tx = self.transaction()
        _, manifest_data, *_ = self.bundle()
        for changes in (dict(reparse=True), dict(links=2), dict(objectId="0" * 16)):
            with self.subTest(changes=changes):
                node = self.server.add("library/meetings", directory=True)
                node.update(changes)
                with self.assertRaises(SmbError):
                    self.write(tx, MANIFEST, manifest_data)
                self.assertNotIn("library/" + MANIFEST, self.server.nodes)

    def test_local_query_and_inventory_bounds_refuse_excess(self):
        tx = self.transaction()
        with patch("journal.MAX_ENTRIES", 0):
            with self.assertRaises(SmbError):
                pending_transactions(self.binding, self.app)
        self.server.add("library/control", directory=True)
        self.server.add("library/control/pending", directory=True)
        self.server.add("library/control/pending/" + DEVICE, directory=True)
        _, _, _, intent_value, _ = self.bundle()
        self.server.add(
            "library/control/pending/" + DEVICE + "/" + REVISION + ".json",
            encoded(intent_value),
        )
        with patch("transaction.MAX_ENTRIES", 0):
            with self.assertRaises(SmbError):
                tx.inventory()

    def test_confirmation_reopens_every_required_artifact_without_unpin_gap(self):
        tx = self.transaction()
        marker_value, intent_value = self.publish(tx)
        paths = [
            MANIFEST,
            PREFIX + "/meeting.json",
            MARKER,
            intent_value["audio"]["path"],
        ]
        old = {
            path: next(h for full, h, _ in tx.transport.pins if full == "library/" + path)
            for path in paths
        }
        self.assertEqual(tx.confirm(marker_value), "remote-confirmed")
        for path in paths:
            self.assertTrue(old[path].closed)
            current = next(h for full, h, _ in tx.transport.pins if full == "library/" + path)
            self.assertIsNot(current, old[path])
            self.assertFalse(current.closed)

    def test_confirmation_requires_exact_marker_bytes(self):
        tx = self.transaction()
        marker_value, _ = self.publish(tx)
        self.server.nodes["library/" + MARKER]["data"] = json.dumps(marker_value, indent=2).encode()
        self.server.nodes["library/" + MARKER]["bytes"] = len(
            self.server.nodes["library/" + MARKER]["data"]
        )
        with self.assertRaises(SmbError):
            tx.confirm(marker_value)

    def test_read_only_v3_transaction_refuses_before_claim_effects(self):
        self.binding["readOnly"] = True
        with self.assertRaises(SmbError):
            self.transaction(dict(self.context, kind="read"))
        self.assertFalse(any(e[0] in ("create", "rename") for e in self.server.events))
        self.assertNotIn("library/.heed-claim", self.server.nodes)
        self.binding["readOnly"] = False
        self.server.read_only = True
        with self.assertRaises(SmbError):
            self.transaction(dict(self.context, kind="read"))
        self.assertFalse(any(e[0] in ("create", "rename") for e in self.server.events))

    def test_payload_requires_owned_pending_intent_after_manifest(self):
        tx = self.transaction()
        body, manifest_data, *_ = self.bundle()
        self.write(tx, MANIFEST, manifest_data)
        with self.assertRaises(SmbError):
            self.write(tx, PREFIX + "/meeting.json", body)
        self.assertNotIn("library/" + PREFIX + "/meeting.json", self.server.nodes)

    def test_payload_audio_must_match_admitted_pending_intent(self):
        tx = self.transaction()
        body, manifest_data, _, intent_value, _ = self.bundle(True)
        self.write(tx, MANIFEST, manifest_data)
        wrong = copy.deepcopy(intent_value)
        wrong["audio"]["sha256"] = "a" * 64
        wrong["audio"]["path"] = "objects/" + "a" * 64
        tx.write_pending(wrong)
        with self.assertRaises(SmbError):
            self.write(tx, PREFIX + "/meeting.json", body)
        self.assertNotIn("library/" + PREFIX + "/meeting.json", self.server.nodes)

    def replace_recovery_effect_open(self, path, directory=False, data=b""):
        original = self.server.open
        replacements = []

        def substituted(candidate, *args, **kwargs):
            if (
                candidate == path
                and not kwargs.get("verification")
                and not kwargs.get("exclusive")
                and kwargs.get("access") in ("delete", "write-delete")
            ):
                replacements.append(self.server.add(path, data, directory))
            return original(candidate, *args, **kwargs)

        self.server.open = substituted
        return replacements

    def test_recovered_file_effect_handle_must_match_before_any_write_or_rename(self):
        for replacement_data in (b"", b'{"schemaVersion":1'):
            with self.subTest(prefix=replacement_data):
                self.server = MemoryServer()
                self.context["operationId"] = str(uuid4())
                tx = self.transaction()
                _, manifest_data, *_ = self.bundle()
                self.server.fault = "flush"
                with self.assertRaises(SmbError):
                    self.write(tx, MANIFEST, manifest_data)
                stage = "library/" + tx.journal.data["allocations"][MANIFEST]["stage"]
                tx.abort()
                resumed = self.transaction()
                before = len(self.server.events)
                replacements = self.replace_recovery_effect_open(stage, data=replacement_data)
                with self.assertRaises(SmbError):
                    self.write(resumed, MANIFEST, manifest_data)
                self.assertEqual(len(replacements), 1)
                self.assertEqual(replacements[0]["data"], replacement_data)
                self.assertIs(self.server.nodes.get(stage), replacements[0])
                self.assertNotIn("library/" + MANIFEST, self.server.nodes)
                self.assertFalse(any(e[0] == "rename" for e in self.server.events[before:]))
                resumed.abort()

    def test_recovered_directory_effect_handle_must_match_before_rename(self):
        tx = self.transaction()
        _, manifest_data, *_ = self.bundle()
        rename = self.server.rename

        def interrupted(handle, target):
            if target == "library/meetings":
                raise SmbError()
            return rename(handle, target)

        self.server.rename = interrupted
        with self.assertRaises(SmbError):
            self.write(tx, MANIFEST, manifest_data)
        stage = "library/" + tx.journal.data["allocations"]["meetings"]["stage"]
        tx.abort()
        self.server.rename = rename
        resumed = self.transaction()
        before = len(self.server.events)
        replacements = self.replace_recovery_effect_open(stage, directory=True)
        with self.assertRaises(SmbError):
            self.write(resumed, MANIFEST, manifest_data)
        self.assertEqual(len(replacements), 1)
        self.assertIs(self.server.nodes.get(stage), replacements[0])
        self.assertNotIn("library/meetings", self.server.nodes)
        self.assertFalse(any(e[0] == "rename" for e in self.server.events[before:]))

    def test_prepared_claim_effect_handle_must_match_before_rename(self):
        rename = self.server.rename

        def interrupted(handle, target):
            if target == "library/.heed-claim":
                raise SmbError()
            return rename(handle, target)

        self.server.rename = interrupted
        with self.assertRaises(SmbError):
            self.transaction()
        job = json.loads(next(Path(self.app).rglob("*.json")).read_text())
        self.assertEqual(job["phase"], "prepared")
        stage = "library/" + job["claim"]["stage"]
        self.server.rename = rename
        replacements = self.replace_recovery_effect_open(stage, directory=True)
        before = len(self.server.events)
        with self.assertRaises(SmbError):
            self.transaction()
        self.assertEqual(len(replacements), 1)
        self.assertIs(self.server.nodes.get(stage), replacements[0])
        self.assertNotIn("library/.heed-claim", self.server.nodes)
        self.assertFalse(any(e[0] == "rename" for e in self.server.events[before:]))

    def make_private_jobs(self, total):
        for _ in range(total):
            job = Journal(self.binding, dict(self.context, operationId=str(uuid4())), self.app)
            job.close()
        return sorted(Path(self.app).rglob("*.json"))

    def private_enumeration_count(self, run, maximum):
        real_listdir = os.listdir
        real_scandir = os.scandir
        seen = []

        def listed(fd):
            names = real_listdir(fd)
            seen.extend(names)
            return names

        class CountedScan:
            def __init__(self, fd):
                self.iterator = real_scandir(fd)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.iterator.close()

            def __iter__(self):
                return self

            def __next__(self):
                entry = next(self.iterator)
                seen.append(entry.name)
                return entry

        with patch("journal.os.listdir", side_effect=listed), patch(
            "journal.os.scandir", side_effect=CountedScan
        ):
            with self.assertRaises(SmbError):
                run()
        self.assertGreater(len(seen), 0)
        self.assertLessEqual(len(seen), maximum)

    def test_pending_stops_directory_iteration_at_entry_cap(self):
        self.make_private_jobs(4)
        with patch("journal.MAX_ENTRIES", 1):
            self.private_enumeration_count(lambda: pending_transactions(self.binding, self.app), 4)

    def test_constructor_stops_directory_iteration_at_entry_cap(self):
        self.make_private_jobs(4)
        with patch("journal.MAX_ENTRIES", 1):
            self.private_enumeration_count(lambda: Journal(self.binding, self.context, self.app), 3)

    def test_pending_journal_byte_budget_stops_before_reading_next_file(self):
        jobs = self.make_private_jobs(4)
        read_inodes = []
        real_read = os.read

        def counted(fd, size):
            read_inodes.append(os.fstat(fd).st_ino)
            return real_read(fd, size)

        with patch("journal.MAX_PENDING_JOURNAL_BYTES", jobs[0].stat().st_size, create=True), patch(
            "journal.os.read", side_effect=counted
        ):
            with self.assertRaises(SmbError):
                pending_transactions(self.binding, self.app)
        self.assertEqual(set(read_inodes), {jobs[0].stat().st_ino})

    def test_pending_response_budget_stops_before_processing_remaining_jobs(self):
        jobs = self.make_private_jobs(4)
        read_inodes = []
        real_read = os.read

        def counted(fd, size):
            read_inodes.append(os.fstat(fd).st_ino)
            return real_read(fd, size)

        with patch("journal.MAX_PENDING_RESPONSE_BYTES", 100, create=True), patch(
            "journal.os.read", side_effect=counted
        ):
            with self.assertRaises(SmbError):
                pending_transactions(self.binding, self.app)
        self.assertEqual(set(read_inodes), {jobs[0].stat().st_ino})

    def test_pending_admission_budget_stops_before_retaining_excess_entries(self):
        job = Journal(self.binding, self.context, self.app)
        for _ in range(3):
            path = f"meetings/{MEETING}/revisions/{uuid4()}/manifest.json"
            job.data["admissions"][path] = "a" * 64
            job.data["allocations"][path] = dict(
                stage=".heed-claim/" + str(uuid4()),
                metadata=None,
                bytes=23,
                sha256="a" * 64,
                state="planned",
                directory=False,
            )
        job.save()
        job.close()
        with patch("journal.MAX_PENDING_ADMISSIONS", 1, create=True):
            with self.assertRaises(SmbError):
                pending_transactions(self.binding, self.app)

    def run_fifo_query(self, body):
        code = (
            f"import sys; sys.path.insert(0, {str(Path(__file__).resolve().parent)!r})\nimport os, journal\nfrom protocol import SmbError\njournal.physical_uuid=lambda:{PHYSICAL!r}\n"
            + body
        )
        try:
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", code],
                capture_output=True,
                timeout=2,
                check=False,
            )
        except subprocess.TimeoutExpired:
            self.fail("private FIFO blocked before descriptor regularity validation")
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout, b"bounded-refusal\n")

    def test_fifo_journal_is_rejected_without_waiting_for_writer(self):
        job_path = self.make_private_jobs(1)[0]
        job_path.unlink()
        os.mkfifo(job_path, 0o600)
        self.run_fifo_query(
            f"fd=os.open({str(job_path.parent)!r},os.O_RDONLY|os.O_DIRECTORY)\ntry:\n journal.read_json(fd,{job_path.name!r})\nexcept SmbError:\n print('bounded-refusal')\nelse:\n raise AssertionError('FIFO journal accepted')\nfinally:\n os.close(fd)\n"
        )

    def test_fifo_guard_is_unrecoverable_without_waiting_for_writer(self):
        job_path = self.make_private_jobs(1)[0]
        guard = job_path.with_suffix(".guard")
        guard.unlink()
        os.mkfifo(guard, 0o600)
        self.run_fifo_query(
            f"result=journal.pending_transactions({self.binding!r},{self.app!r})\nassert len(result)==1 and result[0]['recoverable'] is False\nprint('bounded-refusal')\n"
        )


class SdkRenameTests(unittest.TestCase):
    def test_actual_sdk_rename_uses_zero_root_nonreplace_share_relative_target(self):
        try:
            from smbprotocol.open import SMB2SetInfoRequest
            from smbprotocol.file_info import FileRenameInformation
        except ImportError:
            self.skipTest("pinned SDK unavailable")
        self.assertTrue(
            hasattr(SmbProtocolBackend, "rename"),
            "exact handle rename is not implemented",
        )
        backend = SmbProtocolBackend()
        sent = []
        backend.session = SimpleNamespace(session_id=17)
        backend.tree = SimpleNamespace(tree_connect_id=23)
        response = SimpleNamespace()
        backend.connection = SimpleNamespace(
            send=lambda request, **kw: sent.append((request, kw)),
            receive=lambda request, **kw: response,
        )
        backend.rename(SimpleNamespace(file_id=b"X" * 16), "library/commits/final.json")
        request, routing = sent[0]
        self.assertIsInstance(request, SMB2SetInfoRequest)
        self.assertEqual(request["file_id"].get_value(), b"X" * 16)
        info = FileRenameInformation()
        info.unpack(request["buffer"].get_value())
        self.assertFalse(info["replace_if_exists"].get_value())
        self.assertEqual(info["root_directory"].get_value(), 0)
        self.assertEqual(info["file_name"].get_value(), "library\\commits\\final.json")
        self.assertEqual(routing, dict(sid=17, tid=23))

    def test_actual_sdk_disposition_uses_exact_handle_and_open_has_no_delete_on_close(self):
        try:
            from smbprotocol.open import Open,SMB2SetInfoRequest,CreateOptions,ShareAccess
            from smbprotocol.file_info import FileDispositionInformation
        except ImportError:self.skipTest("pinned SDK unavailable")
        backend=SmbProtocolBackend();sent=[];received=[]
        backend.session=SimpleNamespace(session_id=17)
        backend.tree=SimpleNamespace(tree_connect_id=23,session=SimpleNamespace(connection=SimpleNamespace(dialect=0x311)))
        backend.connection=SimpleNamespace(send=lambda request,**kw:sent.append((request,kw)),receive=lambda request,**kw:received.append(kw))
        original=Open.create
        packets=[]
        def capture(handle,*args,**kwargs):
            request,_=original(handle,*args,**kwargs,send=False)
            packets.append(request)
        with patch.object(Open,"create",capture):handle=backend.open("library/commits/exact.json",access="delete")
        create=packets[0]
        self.assertFalse(create["create_options"].get_value() & CreateOptions.FILE_DELETE_ON_CLOSE)
        self.assertEqual(create["share_access"].get_value(),ShareAccess.FILE_SHARE_READ)
        self.assertTrue(create["desired_access"].get_value() & 0x10000)
        handle.file_id=b"X"*16
        backend.disposition(handle)
        request,routing=sent[0];self.assertIsInstance(request,SMB2SetInfoRequest)
        self.assertEqual(request["file_id"].get_value(),b"X"*16)
        info=FileDispositionInformation();info.unpack(request["buffer"].get_value())
        self.assertTrue(info["delete_pending"].get_value())
        self.assertEqual(routing,dict(sid=17,tid=23));self.assertEqual(received,[dict(resolve_symlinks=False)])
