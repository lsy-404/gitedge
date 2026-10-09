#!/usr/bin/env bash
# Regenerates fixtures.json with real ssh-keygen and git signatures. Private keys stay in a
# temporary directory that is removed on exit.
set -euo pipefail

out="$(cd "$(dirname "$0")" && pwd)/fixtures.json"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

ssh-keygen -q -t ed25519 -N "" -C fixture-ed25519 -f ed25519
ssh-keygen -q -t ecdsa -b 256 -N "" -C fixture-ecdsa -f ecdsa
ssh-keygen -q -t rsa -b 3072 -N "" -C fixture-rsa -f rsa
ssh-keygen -q -t ed25519 -N "" -C fixture-other -f other

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git init -q -b main repo
cd repo
git config gpg.format ssh
git config commit.gpgsign false
export GIT_AUTHOR_NAME="Fixture Signer" GIT_AUTHOR_EMAIL=signer@example.test
export GIT_COMMITTER_NAME="Fixture Signer" GIT_COMMITTER_EMAIL=signer@example.test
export GIT_AUTHOR_DATE="1790000000 +0000" GIT_COMMITTER_DATE="1790000000 +0000"

echo base > README.md
git add README.md
git commit -q -m "Base"
base=$(git rev-parse HEAD)

commit_with() {
  local key="$1" file="$2" message="$3"
  echo "$message" > "$file"
  git add "$file"
  git -c user.signingkey="$work/$key" commit -q -S -m "$message"
  git rev-parse HEAD
}

git switch -q -c signed
ed25519_commit=$(commit_with ed25519 signed.txt "Signed with ed25519")
ecdsa_commit=$(commit_with ecdsa ecdsa.txt "Signed with ecdsa")
rsa_commit=$(commit_with rsa rsa.txt "Signed with rsa")

git switch -q -c unknown "$base"
other_commit=$(commit_with other other.txt "Signed with an unregistered key")

git switch -q -c unsigned "$base"
echo plain > plain.txt
git add plain.txt
git commit -q -m "Not signed"
unsigned_commit=$(git rev-parse HEAD)

git switch -q -c impersonation "$base"
victim_commit=$(GIT_COMMITTER_EMAIL=victim@example.test commit_with ed25519 victim.txt "Claims another committer")

git -c user.signingkey="$work/ed25519" tag -s -m "Release v1.0.0" v1.0.0 "$ed25519_commit"
git -c user.signingkey="$work/ecdsa" tag -s -m "Release v1.1.0" v1.1.0 "$ecdsa_commit"
git tag -a -m "Unsigned release" v0.9.0 "$base"
git tag v0.8.0 "$base"

printf 'signer@example.test %s\n' "$(cat ../ed25519.pub)" > ../allowed
printf 'signer@example.test %s\n' "$(cat ../ecdsa.pub)" >> ../allowed
printf 'signer@example.test %s\n' "$(cat ../rsa.pub)" >> ../allowed
git -c gpg.ssh.allowedSignersFile=../allowed verify-commit "$ed25519_commit" "$ecdsa_commit" "$rsa_commit" 2>/dev/null
git -c gpg.ssh.allowedSignersFile=../allowed verify-tag v1.0.0 v1.1.0 2>/dev/null

printf 'GitEdge signing key ownership\nChallenge: fixture\n' > ../proof.txt
ssh-keygen -q -Y sign -n gitedge -f ../ed25519 ../proof.txt && mv ../proof.txt.sig ../proof-ed25519.sig
ssh-keygen -q -Y sign -n git -f ../ed25519 ../proof.txt && mv ../proof.txt.sig ../proof-git.sig
ssh-keygen -q -Y sign -n gitedge -O hashalg=sha256 -f ../ecdsa ../proof.txt &&
  mv ../proof.txt.sig ../proof-ecdsa-sha256.sig

objects() {
  git rev-list --objects --all | cut -d' ' -f1 | while read -r oid; do
    printf '{"oid":"%s","type":"%s","content":"%s"}\n' "$oid" "$(git cat-file -t "$oid")" \
      "$(git cat-file "$(git cat-file -t "$oid")" "$oid" | base64 | tr -d '\n')"
  done
  for tag in v1.0.0 v1.1.0 v0.9.0; do
    oid=$(git rev-parse "refs/tags/$tag")
    printf '{"oid":"%s","type":"tag","content":"%s"}\n' "$oid" \
      "$(git cat-file tag "$oid" | base64 | tr -d '\n')"
  done
}

objects > ../objects.ndjson

node --input-type=module - "$out" <<EOF
import { readFileSync, writeFileSync } from "node:fs";
const read = (name) => readFileSync("$work/" + name, "utf8");
const objects = new Map();
for (const line of read("objects.ndjson").trim().split("\n"))
  objects.set(JSON.parse(line).oid, JSON.parse(line));
writeFileSync(
  process.argv[2],
  JSON.stringify(
    {
      keys: {
        ed25519: read("ed25519.pub").trim(),
        ecdsa: read("ecdsa.pub").trim(),
        rsa: read("rsa.pub").trim(),
        other: read("other.pub").trim(),
      },
      fingerprints: {
        ed25519: "$(ssh-keygen -l -E sha256 -f ../ed25519.pub | cut -d' ' -f2)",
        ecdsa: "$(ssh-keygen -l -E sha256 -f ../ecdsa.pub | cut -d' ' -f2)",
        rsa: "$(ssh-keygen -l -E sha256 -f ../rsa.pub | cut -d' ' -f2)",
        other: "$(ssh-keygen -l -E sha256 -f ../other.pub | cut -d' ' -f2)",
      },
      proof: {
        payload: read("proof.txt"),
        ed25519: read("proof-ed25519.sig"),
        wrongNamespace: read("proof-git.sig"),
        ecdsaSha256: read("proof-ecdsa-sha256.sig"),
      },
      commits: {
        base: "$base",
        ed25519: "$ed25519_commit",
        ecdsa: "$ecdsa_commit",
        rsa: "$rsa_commit",
        other: "$other_commit",
        unsigned: "$unsigned_commit",
        victim: "$victim_commit",
      },
      tags: {
        ed25519: "$(git rev-parse refs/tags/v1.0.0)",
        ecdsa: "$(git rev-parse refs/tags/v1.1.0)",
        unsigned: "$(git rev-parse refs/tags/v0.9.0)",
      },
      objects: [...objects.values()],
    },
    null,
    2
  ) + "\n"
);
EOF
