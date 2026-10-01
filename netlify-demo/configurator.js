/* Operator configurator for the RandomX embed. The form becomes a snippet,
 * validated and estimated with RandomXEmbed.plan() (no instance, engine or
 * network); the preview runs it on this device after consent. Snippet,
 * escaping and the consent notice follow public/embed-builder.js. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const form = $('configurator');
  const field = name => form.elements.namedItem(name);
  const output = $('snippet'), status = $('status'), preview = $('preview'), previewStatus = $('previewStatus');
  const embedScript = document.querySelector('script[src$="/embed.js"]');
  if (!window.RandomXEmbed) {
    $('loadError').hidden = false;
    $('loadError').textContent = `The embed did not load from ${embedScript ? embedScript.src : 'its script URL'}. ` +
      'This page needs it to check settings and preview; reload, or check the network and content blockers.';
    document.querySelectorAll('input, select, button').forEach(el => { el.disabled = true; });
    return;
  }
  const HEADERS = ['Cross-Origin-Opener-Policy: same-origin', 'Cross-Origin-Embedder-Policy: require-corp',
    'Permissions-Policy: cross-origin-isolated=(self)'];
  const pairs = HEADERS.map(line => line.split(': '));
  $('embedVersion').textContent = 'embed ' + RandomXEmbed.version;
  $('headerBlock').textContent = HEADERS.join('\n');
  $('hostNetlify').textContent = '/*\n' + HEADERS.map(line => '  ' + line).join('\n');
  $('hostNginx').textContent = pairs.map(([name, value]) => `add_header ${name} "${value}" always;`).join('\n');
  $('hostApache').textContent = pairs.map(([name, value]) => `Header always set ${name} "${value}"`).join('\n');
  field('scriptURL').value = embedScript ? embedScript.src : '';
  // This page's own isolation: whether a full-mode preview can run here.
  const modes = RandomXEmbed.diagnose('full').modes;
  const here = (el, ok, text) => { el.dataset.mark = ok ? '✓' : '✗'; el.textContent = text; };
  here($('isolationFull'), modes.full, modes.full ? 'This page is cross-origin isolated, so a full-mode preview can run here.' :
    'This page is not cross-origin isolated, so a full-mode preview stops before it starts. Light mode runs here.');
  here($('isolationLight'), modes.light, modes.light ? 'Light mode can run on this page' + (modes.full ? '.' : ', which is not isolated.') :
    'This browser lacks Worker or WebAssembly support, so no mode can run here.');
  let instance = null, previewed = '';

  function settings() {
    const light = field('mode').value === 'light';
    const max = field('maxThreads').value.trim();
    // Full: an optional thread ceiling and ARM halving. Light: the RAM budget
    // and the boost; the embed derives workers and replicas from them.
    return { wallet: field('wallet').value.trim(), pool: field('pool').value.trim(), port: Number(field('port').value),
      proxy: field('proxy').value.trim(), routeQuery: field('routeQuery').value !== 'false',
      workerName: field('workerName').value.trim(), workload: Number(field('workload').value),
      mode: light ? 'light' : 'full',
      ...(light ? { memory: Number(field('memory').value), memoryCap: Number(field('memoryCap').value),
        replicas: field('boost').checked ? 'auto' : 0 } :
        { ...(max ? { maxThreads: Number(max) } : {}), ...(field('optimizeArm').checked ? { optimizeArm: true } : {}) }),
      nonceMode: field('nonceMode').value, keepalive: field('keepalive').value,
      headless: field('display').value === 'headless', quickstart: field('quickstart').checked };
  }
  const html = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const json = value => JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  function snippet(config) {
    // Absolute only: the snippet runs on the operator's site, not on this page.
    let src;
    try { src = new URL(field('scriptURL').value.trim()); } catch (_) { throw new Error('Script URL must be absolute: https://…/dist/embed.js'); }
    if (!['http:', 'https:'].includes(src.protocol) || src.username || src.password) throw new Error('Use an HTTP(S) embed script URL');
    const lines = [];
    if (config.mode === 'full') {
      lines.push(`<!-- RandomX embed, full mode. The HTML response of this page must send
  ${HEADERS.join('\n  ')}
(allow cross-origin-isolated in an existing Permissions-Policy instead of a second one).
Without them the embed stops at its preflight check and does not mine; mode "light" needs none. -->`);
    }
    if (config.headless) {
      lines.push(`<section id="randomx-custom" aria-label="Mining controls">
  <p id="rx-disclosure"></p>
  <label>CPU % <input id="rx-workload" type="number" min="0" max="80" step="any" value="${config.workload}"></label>
  ${config.quickstart ? '' : '<label><input id="rx-consent" type="checkbox"> I agree to use my device for this session.</label>\n  '}<button id="rx-start" type="button">Start mining</button>
  <button id="rx-stop" type="button">Stop mining</button>
  <p id="rx-status" role="status"></p><output id="rx-rate">0 H/s</output>
</section>`);
    }
    lines.push(`<script src="${html(src.href)}" crossorigin="anonymous" data-auto="false"></script>`);
    lines.push('<script>');
    if (config.quickstart) {
      lines.push(`// Replace this handler with your site's consent statement / dialog.
// Call accept() only after informed consent; decline() cancels the request.
document.addEventListener('randomx:consent-request', function (event) {
  if (event.detail.instance !== window.randomxMiner) return;
  if (window.confirm(event.detail.disclosure)) event.detail.accept();
  else event.detail.decline();
});`);
    }
    lines.push('window.randomxMiner = RandomXEmbed.create(' + json(config) + ');');
    if (config.headless) {
      lines.push(`window.randomxMiner.bindControls({
  start: '#rx-start', stop: '#rx-stop', ${config.quickstart ? '' : "consent: '#rx-consent', "}
  workload: '#rx-workload', disclosure: '#rx-disclosure',
  status: '#rx-status', hashrate: '#rx-rate'
});`);
    }
    lines.push('</script>');
    return lines.join('\n');
  }

  const gb = mib => (mib / 1000).toFixed(1) + ' GB';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function estimate(p, config) {
    const { cores, reportedCores, arm, armOptimized } = p.limits;
    const memory = navigator.deviceMemory;
    const rows = [['Reported cores', String(reportedCores) + (armOptimized ? `, counted as ${cores} (ARM: half)` :
        config.optimizeArm && !arm ? ' (not ARM: no halving)' : '')],
      ['Workload', `${config.workload} % → ${plural(p.wantedThreads, 'thread')}`]];
    if (p.mode === 'light') {
      rows.push(['RAM budget', `${(p.memoryBudgetMiB / 1024).toFixed(1)} GB, ` + (p.memorySource === 'reported' ?
          `${config.memory} % of the reported ${memory} GB` : `the ${config.memoryCap} GB cap (no RAM reported)`)],
        ['Light workers', String(p.workers - p.replicas) + (p.threads < p.wantedThreads ? ` (the budget holds ${p.threads} of ${p.wantedThreads} threads)` : '')],
        ['Full-dataset', p.replicas ? `${p.replicas} (${config.replicas === 'auto' ? 'best mix for this budget' : 'fixed'})` :
          config.replicas === 'auto' ? '0: none pays off within this budget' : 'off'],
        ['RAM', `about ${gb(p.memoryMiB)} while mining`]);
      if (p.replicas) rows.push(['Dataset build', `on the ${plural(p.workers, 'worker')}, before mining starts and after each seed change`]);
    } else {
      rows.push(['Dataset build', `${p.initThreads} threads, at the start and after each seed change`], ['RAM', 'about 2.5 GiB']);
    }
    rows.push(['Browser memory', typeof memory === 'number' ? `reports ${memory} GB (rounded; some browsers omit it)` : 'not reported']);
    if (!p.threads) rows.push(['Note', p.wantedThreads ? 'The RAM budget holds no worker: raise RAM % or the cap' :
      'No mining thread at this workload: raise it so Start can run']);
    $('estimate').replaceChildren(...rows.flatMap(([term, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = term; dd.textContent = value; return [dt, dd];
    }));
  }

  function render() {
    const mode = field('mode').value;
    form.querySelectorAll('[data-only]').forEach(el => { el.hidden = el.dataset.only !== mode; });
    try {
      // Only the fields of the shown mode count.
      const invalid = [...form.querySelectorAll('input:invalid, select:invalid')].find(el => !el.closest('[hidden]'));
      if (invalid) throw new Error(invalid.closest('label').firstChild.textContent.trim() + ': ' + invalid.validationMessage);
      const config = settings();
      try { new URL(config.proxy); } catch (_) { throw new Error('WebSocket bridge: enter a wss:// URL'); }
      // The embed's own validation and thread/memory math, without an instance.
      estimate(RandomXEmbed.plan(config), config);
      output.value = snippet(config);
      $('copySnippet').disabled = false;
      status.className = '';
      status.textContent = previewed && previewed !== output.value ? 'Settings changed: show the preview again to use them' : '';
      return true;
    } catch (error) {
      output.value = '';
      $('copySnippet').disabled = true;
      status.className = 'error';
      status.textContent = error.message;
      return false;
    }
  }

  // Confirms beside the button that was pressed; without clipboard access, selects the text instead.
  async function copy(text, done, out, select) {
    try { await navigator.clipboard.writeText(text); out.textContent = done; }
    catch (_) { select(); out.textContent = 'Select the text and copy it'; }
  }
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', render);
  $('copySnippet').addEventListener('click', () => {
    if (render()) copy(output.value, 'Snippet copied', status, () => { output.focus(); output.select(); });
  });
  $('copyHeaders').addEventListener('click', () =>
    copy(HEADERS.join('\n'), 'Headers copied', $('headerStatus'), () => getSelection().selectAllChildren($('headerBlock'))));
  $('switchLight').addEventListener('click', () => {
    const light = form.querySelector('input[name=mode][value=light]');
    light.checked = true; render(); light.focus();
  });

  function clearPreview(message) {
    if (instance) instance.destroy();
    instance = null; previewed = '';
    preview.replaceChildren();
    $('clearPreview').disabled = true;
    previewStatus.textContent = message;
    render();
  }
  $('showPreview').addEventListener('click', event => {
    // A quickstart instance arms a document listener below; this click must not be its first interaction.
    event.stopPropagation();
    if (!render()) { previewStatus.textContent = 'Fix the settings first: ' + status.textContent; form.reportValidity(); return; }
    if (instance) instance.destroy();
    preview.replaceChildren();
    // The configured settings as they are, with the embed this page loaded.
    const config = { ...settings(), container: preview };
    instance = RandomXEmbed.create(config);
    if (config.headless) {
      preview.innerHTML = `<div class="custom-preview"><p>Custom DOM · headless API</p><p class="rx-disclosure"></p>
        <label>CPU % <input class="rx-workload" type="number" min="0" max="80" step="any" value="${config.workload}"></label>
        ${config.quickstart ? '' : '<label><input class="rx-consent" type="checkbox"> I agree to use my device for this session.</label>'}
        <button class="rx-start" type="button">Start mining</button><button class="rx-stop" type="button">Stop</button>
        <p class="rx-status" role="status"></p><output class="rx-rate">0 H/s</output></div>`;
      const q = selector => preview.querySelector(selector);
      instance.bindControls({ start: q('.rx-start'), stop: q('.rx-stop'), consent: q('.rx-consent'),
        workload: q('.rx-workload'), disclosure: q('.rx-disclosure'), status: q('.rx-status'), hashrate: q('.rx-rate') });
    }
    window.configuratorPreview = instance;
    previewed = output.value;
    $('clearPreview').disabled = false;
    previewStatus.textContent = instance.state.error ? 'Preview cannot run on this page: ' + instance.state.error.message :
      'Preview ready. Nothing runs until you agree and press Start.';
    render();
  });
  $('clearPreview').addEventListener('click', () => clearPreview('Preview removed'));
  document.addEventListener('randomx:consent-request', ({ detail }) => {
    if (!instance || detail.instance !== instance) return;
    const old = preview.querySelector('.site-consent'); if (old) old.remove();
    const notice = document.createElement('div'); notice.className = 'site-consent';
    const text = document.createElement('p'); text.textContent = detail.disclosure;
    const allow = document.createElement('button'); allow.type = 'button'; allow.textContent = 'Allow this session';
    const decline = document.createElement('button'); decline.type = 'button'; decline.textContent = 'Decline';
    allow.addEventListener('click', () => { detail.accept(); notice.remove(); });
    decline.addEventListener('click', () => { detail.decline(); notice.remove(); });
    notice.append(text, allow, decline); preview.appendChild(notice); allow.focus();
    previewStatus.textContent = 'Consent required';
  });
  window.addEventListener('pagehide', () => { if (instance) instance.destroy(); });
  render();
})();
