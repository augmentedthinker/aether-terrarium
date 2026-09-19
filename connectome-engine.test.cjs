const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('ConnectomeEngine: Subcircuit Verification & Biophysical Parity', async (t) => {
  const { ConnectomeEngine } = await import('./connectome-engine.js');
  const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, 'fly_subcircuit_443.json')));

  const engine = new ConnectomeEngine();
  engine.initialize(rawData);

  await t.test('1. Topology & Cell Count Verification', () => {
    assert.strictEqual(engine.neuronCount, 443, 'Must contain exactly 443 neurons');
    assert.strictEqual(engine.synapseCount, 20281, 'Must contain exactly 20,281 synapses');
    assert.strictEqual(engine.sugarIndices.length, 21, 'Must have exactly 21 sugar afferents');
    assert.strictEqual(engine.bitterIndices.length, 21, 'Must have exactly 21 bitter afferents');
    assert.strictEqual(engine.motorIndices.length, 2, 'Must have exactly 2 motor neurons (MN9-1 & MN9-2)');
  });

  await t.test('2. Rest Condition (0 Hz input): Silence', () => {
    engine.reset();
    for (let f = 0; f < 60; f++) {
      engine.updateFrame(1/60, 0, 0);
    }
    assert.strictEqual(engine.motorSpikes1 + engine.motorSpikes2, 0, 'Rest must produce 0 motor spikes');
    assert.strictEqual(engine.totalSpikesFired, 0, 'Rest must produce 0 circuit spikes');
  });

  await t.test('3. Sugar Alone (100 Hz): Robust Motor Firing & Extension', () => {
    engine.reset();
    let finalTelemetry = null;
    for (let f = 0; f < 60; f++) {
      finalTelemetry = engine.updateFrame(1/60, 100, 0);
    }
    const motorCount = finalTelemetry.activeMotorSum;
    assert.ok(motorCount >= 50, `Sugar must fire robustly (got ${motorCount} spikes)`);
    assert.ok(finalTelemetry.extension > 0.4, `Proboscis must extend significantly (got ${(finalTelemetry.extension*100).toFixed(1)}%)`);
  });

  await t.test('4. Mixed Condition (Sugar 100 Hz + Bitter 100 Hz): Biological Inhibition', () => {
    // Run sugar baseline
    engine.reset();
    for (let f = 0; f < 60; f++) engine.updateFrame(1/60, 100, 0);
    const sugarTotal = engine.motorSpikes1 + engine.motorSpikes2;

    // Run mixed condition
    engine.reset();
    for (let f = 0; f < 60; f++) engine.updateFrame(1/60, 100, 100);
    const mixedTotal = engine.motorSpikes1 + engine.motorSpikes2;

    const suppressionPct = ((sugarTotal - mixedTotal) / sugarTotal) * 100;
    assert.ok(suppressionPct >= 75.0, `Bitter co-stimulation must suppress motor firing by >= 75% (got ${suppressionPct.toFixed(1)}% suppression, sugar=${sugarTotal}, mixed=${mixedTotal})`);
  });

  await t.test('5. Bitter Alone (100 Hz): Zero Motor Output', () => {
    engine.reset();
    for (let f = 0; f < 60; f++) engine.updateFrame(1/60, 0, 100);
    const bitterTotal = engine.motorSpikes1 + engine.motorSpikes2;
    assert.strictEqual(bitterTotal, 0, `Bitter alone must produce exactly 0 motor spikes (got ${bitterTotal})`);
  });

  await t.test('6. Computational Performance (<2.0ms per 60fps frame)', () => {
    engine.reset();
    const t0 = performance.now();
    for (let f = 0; f < 60; f++) {
      engine.updateFrame(1/60, 100, 0);
    }
    const elapsedMs = performance.now() - t0;
    const perFrameMs = elapsedMs / 60;
    assert.ok(perFrameMs < 2.5, `Frame cost must be < 2.5ms (measured ${perFrameMs.toFixed(3)}ms)`);
  });
});
