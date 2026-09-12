async page => {
  const results = [];
  for (const index of [0, 1, 2]) {
    const tab = await page.context().newPage();
    await tab.addInitScript(({ index }) => {
      const callbacks = new Map(); let id = 0;
      window.smoke = { now: 100000, events: {}, surfaces: [], logs: [] };
      Date.now = () => window.smoke.now;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: `screensaver-${index}` } },
        transformCallback(fn) { callbacks.set(++id, fn); return id; },
        async invoke(cmd, args) {
          if (cmd === 'capture_desktop') {
            const c = document.createElement('canvas'); c.width = 600; c.height = 400;
            const g = c.getContext('2d'); g.fillStyle = '#bb5522'; g.fillRect(0,0,600,400);
            return { x: (index-1)*600, y: index===1?0:-20, width:600,height:400,
              virtualDesktop:{x:-600,y:-20,width:1800,height:420},
              png:c.toDataURL().split(',')[1],sprites:[{x:100,y:100,width:200,height:150,png:c.toDataURL().split(',')[1]}],seeThrough:true };
          }
          if (cmd === 'get_settings') return {screensaverErosionStyle:'cracks',screensaverErosionSpeed:0};
          if (cmd === 'plugin:event|listen') {window.smoke.events[args.event]=callbacks.get(args.handler);return 1;}
          if (cmd === 'screensaver_surfaces') window.smoke.surfaces=args.surfaces;
          if (cmd === 'append_log') window.smoke.logs.push(args.line);
          return null;
        }
      };
    }, { index });
    await tab.goto('http://localhost:1420/screensaver.html');
    await tab.waitForFunction(() => document.querySelector('#loading').hidden);
    const sample = () => tab.evaluate(() => {
      const c=document.querySelector('canvas'),data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let lit=0,transparent=0;for(let i=0;i<data.length;i+=4){if(data[i]+data[i+1]+data[i+2]>40)lit++;if(data[i+3]<255)transparent++;}
      return {lit,transparent,surfaces:window.smoke.surfaces.length};
    });
    const initial=await sample();
    if (!initial.lit) throw new Error('Snapshot missing');
    await tab.evaluate(() => window.smoke.events['screensaver-crt']({payload:{startedAt:100000,voidSeconds:2}}));
    await tab.evaluate(() => {window.smoke.now=101100;});
    await tab.waitForTimeout(100);
    const dot=await sample();
    if ((index===1) !== (dot.lit>0)) throw new Error('CRT dot must belong to primary only: '+index+JSON.stringify(dot));
    await tab.evaluate(() => {window.smoke.now=101500;});
    await tab.waitForTimeout(100);
    const hold=await sample();
    if(hold.lit || hold.transparent || hold.surfaces) throw new Error('Void must be opaque black and unstandable');
    await tab.evaluate(() => {window.smoke.now=103351;});
    await tab.waitForTimeout(180);
    const restored=await sample();
    if(!restored.lit || !restored.surfaces) throw new Error('Snapshot/surfaces did not restore');
    results.push({index,initial,dot,hold,restored});await tab.close();
  }
  return results;
}