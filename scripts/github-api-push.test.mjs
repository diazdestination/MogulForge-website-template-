/**
 * Tests for the dedup / blob-skip optimisation in github-api-push.mjs.
 *
 * Three scenarios are covered:
 *   1. gitBlobSha() produces the same SHA as `git hash-object` for a known buffer.
 *   2. When the remote tree already contains a matching blob SHA, the POST to
 *      /git/blobs is NOT called for that file.
 *   3. When the remote tree is empty (new repo), every file goes through a
 *      blob POST (nothing is skipped).
 */

import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { gitBlobSha } from "./github-api-push.mjs";

// ---------------------------------------------------------------------------
// Helper — mirrors the dedup decision from the chunk loop in github-api-push.mjs
//
//   if (remoteSha && remoteSha === localSha) → reuse, skip blob POST
//   else                                      → call ghApi POST /git/blobs
//
// Returns { blobSha, posted } where `posted` is true when a blob upload
// was required.
// ---------------------------------------------------------------------------
async function processFile({ content, remoteSha, ghApiBlobPost }) {
  const localSha = gitBlobSha(content);

  if (remoteSha && remoteSha === localSha) {
    return { blobSha: remoteSha, posted: false };
  }

  const blob = await ghApiBlobPost(content);
  return { blobSha: blob.sha, posted: true };
}

// ---------------------------------------------------------------------------
// 1. gitBlobSha() — known-good SHA from `git hash-object`
// ---------------------------------------------------------------------------
describe("gitBlobSha()", () => {
  it("produces the correct SHA for a known ASCII buffer", () => {
    // `echo -n 'hello world' | git hash-object --stdin`
    // → 95d09f2b10159347eece71399a7e2e907ea3df4f
    const buf = Buffer.from("hello world", "utf8");
    expect(gitBlobSha(buf)).toBe("95d09f2b10159347eece71399a7e2e907ea3df4f");
  });

  it("produces the correct SHA for an empty buffer", () => {
    // `git hash-object /dev/null`
    // → e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
    const buf = Buffer.alloc(0);
    expect(gitBlobSha(buf)).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("matches the standard git object-hash formula sha1('blob <len>\\0<data>')", () => {
    const content = Buffer.from("some arbitrary content for testing", "utf8");

    const expected = createHash("sha1")
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest("hex");

    expect(gitBlobSha(content)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 2. Blob POST is skipped when the remote tree already has a matching SHA
// ---------------------------------------------------------------------------
describe("dedup optimisation — unchanged file", () => {
  it("does NOT call the blob POST when the remote SHA matches the local SHA", async () => {
    const content = Buffer.from("unchanged file content", "utf8");
    const localSha = gitBlobSha(content);

    // Remote tree already has this exact blob
    const remoteTree = new Map([["src/file.ts", localSha]]);

    const ghApiBlobPost = vi.fn().mockResolvedValue({ sha: "should-not-be-used" });

    const { blobSha, posted } = await processFile({
      content,
      remoteSha: remoteTree.get("src/file.ts"),
      ghApiBlobPost,
    });

    expect(posted).toBe(false);
    expect(ghApiBlobPost).not.toHaveBeenCalled();
    expect(blobSha).toBe(localSha);
  });

  it("reuses the exact remote SHA as the tree entry", async () => {
    const content = Buffer.from("reused content", "utf8");
    const remoteSha = gitBlobSha(content); // same content → same sha

    const ghApiBlobPost = vi.fn();

    const { blobSha } = await processFile({
      content,
      remoteSha,
      ghApiBlobPost,
    });

    expect(blobSha).toBe(remoteSha);
  });

  it("uploads a blob when the remote SHA differs (file changed)", async () => {
    const oldContent = Buffer.from("old content", "utf8");
    const newContent = Buffer.from("new content", "utf8");
    const remoteSha = gitBlobSha(oldContent);
    const newSha = gitBlobSha(newContent);

    const ghApiBlobPost = vi.fn().mockResolvedValue({ sha: newSha });

    const { blobSha, posted } = await processFile({
      content: newContent,
      remoteSha,
      ghApiBlobPost,
    });

    expect(posted).toBe(true);
    expect(ghApiBlobPost).toHaveBeenCalledOnce();
    expect(blobSha).toBe(newSha);
  });
});

// ---------------------------------------------------------------------------
// 3. All files are uploaded when the remote tree is empty (new repo)
// ---------------------------------------------------------------------------
describe("new repo — empty remote tree", () => {
  it("uploads every file when fetchCurrentTree returns an empty Map", async () => {
    const files = [
      { rel: "README.md", content: Buffer.from("# hello", "utf8") },
      { rel: "src/index.ts", content: Buffer.from("export {};", "utf8") },
      { rel: "package.json", content: Buffer.from('{"name":"x"}', "utf8") },
    ];

    const remoteTree = new Map(); // empty — new repo

    const uploadedPaths = [];
    const ghApiBlobPost = vi.fn().mockImplementation(async (content) => {
      return { sha: gitBlobSha(content) };
    });

    const results = await Promise.all(
      files.map(async ({ rel, content }) => {
        const result = await processFile({
          content,
          remoteSha: remoteTree.get(rel), // undefined for every file
          ghApiBlobPost,
        });
        if (result.posted) uploadedPaths.push(rel);
        return result;
      }),
    );

    // Every file must have been uploaded
    expect(ghApiBlobPost).toHaveBeenCalledTimes(files.length);
    expect(uploadedPaths).toHaveLength(files.length);
    expect(results.every((r) => r.posted)).toBe(true);
  });

  it("treats a missing remote entry the same as a new file", async () => {
    const content = Buffer.from("brand new file", "utf8");
    const expectedSha = gitBlobSha(content);

    const ghApiBlobPost = vi.fn().mockResolvedValue({ sha: expectedSha });

    const { blobSha, posted } = await processFile({
      content,
      remoteSha: undefined, // not in remote tree
      ghApiBlobPost,
    });

    expect(posted).toBe(true);
    expect(blobSha).toBe(expectedSha);
  });

  it("skips only matched files and uploads everything else in a mixed batch", async () => {
    const unchangedContent = Buffer.from("unchanged", "utf8");
    const changedContent = Buffer.from("changed now", "utf8");
    const newContent = Buffer.from("brand new", "utf8");

    const unchangedSha = gitBlobSha(unchangedContent);

    const remoteTree = new Map([
      ["a.ts", unchangedSha],
      ["b.ts", gitBlobSha(Buffer.from("old b", "utf8"))], // different → will change
    ]);

    const files = [
      { rel: "a.ts", content: unchangedContent }, // unchanged → skip
      { rel: "b.ts", content: changedContent },   // changed   → upload
      { rel: "c.ts", content: newContent },        // new       → upload
    ];

    const ghApiBlobPost = vi.fn().mockImplementation(async (content) => ({
      sha: gitBlobSha(content),
    }));

    const results = await Promise.all(
      files.map(({ rel, content }) =>
        processFile({ content, remoteSha: remoteTree.get(rel), ghApiBlobPost }),
      ),
    );

    const [aResult, bResult, cResult] = results;

    expect(aResult.posted).toBe(false); // unchanged — skipped
    expect(bResult.posted).toBe(true);  // changed   — uploaded
    expect(cResult.posted).toBe(true);  // new        — uploaded
    expect(ghApiBlobPost).toHaveBeenCalledTimes(2); // b + c
  });
});
