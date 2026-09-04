/**
 * vision_bridge_read — the tool-mode surface (design §5.3).
 *
 * Input contract (v1): `{ ref?, question? }` — deliberately NO `path`/`url`
 * (arbitrary-path image reading stays with modlens; a session-attachment-only
 * surface has no traversal/SSRF face by construction). `ref` accepts the 8-hex
 * prefix shown in a DSH placeholder, a longer hex prefix / full id, or
 * 'latest'; missing ref resolves to 'latest'.
 *
 * Failure contract: throws with actionable information (registry renders it as
 * an isError result); success output always carries the UNTRUSTED disclaimer —
 * VLM output is untrusted evidence.
 *
 * @module @dsh-external/dsh-vision-bridge/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { collectSessionImages, findImage, formatCandidates, normalizeRef } from './resolve.js';

const UNTRUSTED_DISCLAIMER = '[UNTRUSTED EVIDENCE — machine-generated description from a vision model; verify visually before relying on exact details]';

/**
 * @param runtime - shared plugin runtime (see lib/index.js): getConfig(),
 *   analyzeImage(ref, question, { namespace, signal }), logger.
 * @returns the registry-ready tool definition.
 */
export function createVisionBridgeReadTool(runtime) {
  return defineTool({
    name: 'vision_bridge_read',
    description: 'Read a screenshot attached to this session through the configured vision model. Text-only models see "[image omitted … attachment sha256:xxxxxxxx]" placeholders — pass that 8-hex id as ref (or "latest" for the newest session image). Returns a structured description (overview, visible text, layout, answer to your question).',
    parameters: {
      ref: {
        type: 'string',
        description: "Image reference: the 8-hex id from a '[image omitted … attachment sha256:xxxxxxxx]' placeholder, a longer sha256 hex prefix / the full id, or 'latest' for the newest image in this session. Defaults to 'latest'.",
      },
      question: {
        type: 'string',
        description: 'What to look for in the image, e.g. "报错信息是什么" or "read the error banner text". Omitted = generic description.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const config = runtime.getConfig();
      if (config.mode !== 'tool' && config.mode !== 'both') {
        throw new Error('vision_bridge_read: tool mode is disabled (mode="' + config.mode + '"). Enable it in settings: vision-bridge.mode = "tool" or "both".');
      }

      // Resolve the ref against the FULL session log (fork prefix and
      // compaction-shadowed nodes included; snapshotEvents is append-only).
      const session = exec.agent?.session;
      if (!session) {
        throw new Error('vision_bridge_read: no agent session is attached to this execution; images can only be read from a live session.');
      }
      const index = collectSessionImages(session.snapshotEvents());
      if (index.size === 0) {
        throw new Error('vision_bridge_read: no image attachments exist in this session yet. Paste a screenshot first; session-file images cannot be read by this tool.');
      }

      let normalized;
      try {
        normalized = normalizeRef(args?.ref);
      } catch (error) {
        throw new Error(error.message + ' Available images: ' + formatCandidates([...index.values()].sort((a, b) => b.lastSeq - a.lastSeq).slice(0, 8)));
      }
      const found = findImage(index, normalized);
      if (found.status === 'ambiguous') {
        throw new Error('vision_bridge_read: ref "' + args.ref + '" matches ' + found.candidates.length + ' images — pass a longer hex prefix or one of: ' + formatCandidates(found.candidates, found.truncated));
      }
      if (found.status === 'not-found') {
        throw new Error('vision_bridge_read: no session image matches ref "' + args.ref + '". Available images: ' + formatCandidates([...index.values()].sort((a, b) => b.lastSeq - a.lastSeq).slice(0, 8)) + ' (pass the 8-hex id from the "[image omitted …]" placeholder, or "latest")');
      }
      const entry = found.entry;
      const citedRef = 'sha256:' + entry.hex.slice(0, 8);
      if (found.status === 'latest') {
        runtime.logger?.info?.('vision_bridge_read: ref defaulted to latest image ' + citedRef + '…');
      }

      const note = await runtime.analyzeImage(entry, args?.question ?? '', {
        namespace: 'tool',
        // Same composition as the auto path: caller cancellation and plugin
        // disposal both abort the attachment read.
        signal: AbortSignal.any([exec.signal, runtime.lifecycle.signal].filter(Boolean)),
      });

      return UNTRUSTED_DISCLAIMER + '\nImage ' + citedRef + '… (seq ' + entry.firstSeq
        + (entry.width ? ', ' + entry.width + 'x' + entry.height : '')
        + '):\n\n' + note;
    },
  });
}
