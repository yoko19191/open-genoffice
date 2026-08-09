# Spike 06 — shared WebDAV/S3 revision model

The transport is replaceable; the sync semantics are not. Both providers expose the same tiny
object-store contract: read an object with a strong version token, create an immutable object with
`If-None-Match: *`, and compare-and-swap the mutable `head.json` with `If-Match` (or
`If-None-Match: *` for first creation).

## Remote layout

```text
open-genoffice-sync/v1/{project|global}/{scopeId}/
  head.json
  blobs/sha256/{contentDigest}
  revisions/{revisionDigest}.json
```

Project and Global Asset data cannot share a head or be copied into one another. Blob and revision
objects are immutable and content-addressed. `head.json` is the only mutable key and points to the
current revision for every canonical relative path. Transport ETags are CAS tokens only; they are
never treated as content hashes because S3 multipart upload and encryption change ETag semantics.

Each revision records namespace, scope, path, kind, SHA-256 content hash, byte size, tombstone,
zero-to-two parents, author device, executable/network flags and an event. It has no wall-clock field.
The manifest adds a diagnostic generation, parent manifest ID and writer, but correctness comes from
CAS and revision ancestry, not generation or timestamp ordering.

## Reconciliation rules

When one side still equals the last acknowledged base, the changed side can fast-forward. A remote
tombstone always asks for confirmation; missing a previously known manifest entry is never treated
as deletion. When local and remote both diverge, the local working file remains current, the remote
revision is materialized as an open Conflict Copy, and that path is not published until the user
chooses. `keep-local` and `accept-remote` both create a new local resolution revision with the two
heads as parents. The unselected old revision becomes the Conflict Copy. This makes the chosen bytes
the newest local write and prevents the same divergence from recurring.

Offline queues contain only `{ operation: "reconcile", namespace, scopeId }`. On reconnect the
client re-reads `head.json` and replans; it never replays a stale ETag, PUT or delete. Deletes are
tombstone revisions, not missing keys, and immutable objects require retention/garbage collection
outside the first-release sync path.

## Security and ecosystem choices

- WebDAV is HTTPS-only and requires strong ETags. `webdav@5.10.0` supplies Basic, Digest and Bearer
  authentication plus request handling; the small adapter retains conditional-header control. A
  server that strips strong ETags or conditional PUT is incompatible and must fail setup diagnostics.
- S3 uses the official `@aws-sdk/client-s3@3.1106.0`, supports endpoint/region/bucket/prefix and
  path-style, and maps `AES256` and `aws:kms` provider-side encryption. AWS and compatible services
  must pass conditional `PutObject`; versioning alone is not a substitute for CAS.
- CredentialStore resolves credentials only at connection time. Manifest, revision, queues and logs
  contain no secret. Synced executable/network resources are disabled on a new device until local
  hash-bound trust is granted; trust itself never syncs.
- TLS exceptions exist only in explicit loopback probes. The product has no such switch.

## Verify

```bash
npm install
npm run lint
npm run test:coverage
node scripts/probe-webdav.mjs
```

The MinIO probe expects an ephemeral server at `http://127.0.0.1:19000`; its script creates and
removes a random test bucket. Local HTTP is restricted to this probe. AWS S3 TLS and provider-side
encryption remain release-runner gates rather than assumptions derived from MinIO.

Primary semantics: [WebDAV RFC 4918](https://datatracker.ietf.org/doc/html/rfc4918),
[Amazon S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html),
and [S3 server-side encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-s3-encryption.html).
