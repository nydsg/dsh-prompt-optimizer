const market = "C:/Users/\u8054\u60f3/.dsh/profiles/desktop/node_modules/dshmarket/lib/profile.js";
const mod = await import('file://' + market);
const isoProfile = "D:/Codex-workspace/.dsh-iso/profiles/isotest";
// explicitDir 就是 profile 目录本身
const installed = mod.readInstalled('isotest', isoProfile);
console.log('[已安装列表数据源] readInstalled(profile, profileDir) ->');
for (const [name, spec] of Object.entries(installed)) console.log(`   ${name}  <=  ${spec}`);
console.log('\n>>> 包含本插件:', Object.hasOwn(installed, 'dsh-prompt-optimizer'));
console.log('对照 readManifestDeps:', JSON.stringify(mod.readManifestDeps('isotest', isoProfile)));
console.log('\n--- 真机（桌面上你自己的 profile）也一样看这个函数 ---');
const liveProfile = process.env.DSH_PROFILE_DIR;
const liveInstalled = mod.readInstalled('desktop', liveProfile);
console.log('live 已安装列表条目数:', Object.keys(liveInstalled).length);
for (const n of Object.keys(liveInstalled)) console.log('   ', n);
