import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MAX_PROMPT_EXTRA_CHARS } from '../lib/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Static shape assertions for the browser half (design §10.3B/§10.6 "client"):
// node --test cannot mount a browser, so the loader protocol, slot
// registration, inject declaration, and no-JSX/no-build constraints are
// asserted against the file text, and the package manifest against strict
// JSON.parse.

const clientSrc = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('lib/client.js — module-loader factory shape', () => {
  it('registers through window.__ModuleLoader__.load as the first statement', () => {
    assert.ok(clientSrc.startsWith('window.__ModuleLoader__.load({'), 'file must open with the loader registration');
    assert.ok(clientSrc.includes('factory: (require) =>'), 'factory receives require');
    assert.ok(clientSrc.includes('return module.exports;'), 'factory returns module.exports');
  });

  it('uses the package id and requires react (no build step)', () => {
    assert.ok(clientSrc.includes('id: "@dsh-external/dsh-vision-bridge"'));
    assert.ok(clientSrc.includes('require("react")'));
    assert.ok(clientSrc.includes('react.createElement'));
  });

  it('declares the client service inject list', () => {
    assert.ok(clientSrc.includes('["slots", "settingsScope", "locale"]'));
    assert.ok(clientSrc.includes('exports.inject = inject;'));
    assert.ok(clientSrc.includes('exports.apply = apply;'));
    assert.ok(clientSrc.includes('exports.name = name;'));
  });

  it('registers a settings.plugin.item card keyed by the namespace', () => {
    assert.ok(clientSrc.includes('const SLOT_NAME = "settings.plugin.item"'));
    assert.ok(clientSrc.includes('const SETTINGS_NS = "vision-bridge"'));
    assert.ok(clientSrc.includes('key: SETTINGS_NS'));
    assert.ok(clientSrc.includes('ctx.slots.register'));
    assert.ok(clientSrc.includes('ctx.slots.inject(SLOT_NAME'));
  });

  it('binds the settings scope and saves through one atomic mutate', () => {
    assert.ok(clientSrc.includes('ctx.settingsScope.bind({ namespace: SETTINGS_NS })'));
    assert.ok(clientSrc.includes('this.scope.mutate(ops)'));
  });

  it('registers the bilingual locale dictionary', () => {
    assert.ok(clientSrc.includes('const LOCALE_NS = "vision-bridge-ui"'));
    assert.ok(clientSrc.includes('ctx.locale.register(LOCALE_NS, { en, zh })'));
  });

  it('carries no JSX / TypeScript / build artifacts', () => {
    assert.equal(/jsx-runtime|react\/jsx|\/\*\* @jsx/.test(clientSrc), false, 'no jsx runtime pragma');
    assert.equal(/<\/?[A-Za-z][^>]*>/.test(clientSrc), false, 'no JSX element syntax');
    assert.equal(/:\s*(string|number|boolean|any)\b/.test(clientSrc), false, 'no TypeScript type annotations');
    assert.equal(clientSrc.includes('.tsx'), false);
  });

  it('has zero side effects at module load (DOM touched only inside functions)', () => {
    const head = clientSrc.slice(0, clientSrc.indexOf('function installStyles'));
    assert.equal(head.includes('document.'), false, 'no DOM access before the style installer definition');
    assert.ok(clientSrc.includes('ctx.effect(installStyles'), 'styles mount inside apply via ctx.effect');
  });

  it('covers all ten §10.1 fields including the textarea promptExtra', () => {
    for (const id of ['baseURL', 'model', 'credential', 'mode', 'language', 'promptExtra', 'outputFormat', 'timeoutMs', 'concurrency', 'maxPerTurn']) {
      assert.ok(clientSrc.includes(`id: "${id}"`), `field ${id} must be declared`);
    }
    assert.ok(clientSrc.includes('kind: "textarea"'), 'promptExtra uses a multiline textarea');
    assert.ok(clientSrc.includes('/2000'), 'character counter present');
  });

  it('renders the loading and read-only branches', () => {
    assert.ok(clientSrc.includes('t("loading")'), 'loading branch is rendered');
    assert.ok(clientSrc.includes('t("readOnly")'), 'read-only branch is rendered');
  });

  it('keeps the client draft limit in sync with the server bound', () => {
    const match = clientSrc.match(/MAX_PROMPT_EXTRA\s*=\s*(\d+)/);
    assert.ok(match, 'client MAX_PROMPT_EXTRA constant must exist');
    assert.equal(Number(match[1]), MAX_PROMPT_EXTRA_CHARS, 'client and server promptExtra limits must match');
  });
});

describe('package.json — dsh.client declaration', () => {
  it('exposes ./client', () => {
    assert.equal(pkg.exports['./client'], './lib/client.js');
  });

  it('declares the web client half with the three host packages', () => {
    assert.equal(pkg.dsh.client.platform, 'web');
    assert.deepEqual(pkg.dsh.client.inject, [
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
    ]);
  });

  it('ships lib/client.js in files', () => {
    assert.equal(pkg.files.includes('lib/client.js') || pkg.files.includes('lib'), true);
  });
});
