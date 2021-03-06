#!/usr/bin/env node
const program = require('commander');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const pkg = require(path.join(__dirname, '../package.json'));
const version = pkg.version;
const execa = require('execa');
const fs = require('fs');

const buildOptionDefaults = {
  mode: 'production',
  base: '/',
  outDir: 'dist',
  assetsDir: '_assets',
  assetsInlineLimit: 4096,
  sourcemap: false,
  minify: 'terser',
};

const devOptionDefaults = {
  serviceWorker: false,
};

// required after process.env.DEBUG was set so 'debug' works with configured patterns
let vite;
let log = console;

async function setupSvite(options) {
  try {
    vite = require('vite');
  } catch (e) {
    log.error('failed to find vite. Vite is required to run this svite command', e);
    process.exit(1);
  }

  const userConfig = await vite.resolveConfig(options.mode, options.config);
  let viteConfig = {
    ...userConfig,
    ...options,
  };
  if (
    viteConfig.rollupInputOptions &&
    viteConfig.rollupInputOptions.plugins &&
    viteConfig.rollupInputOptions.plugins.some((p) => p.name === 'svite')
  ) {
    log.debug('using svite plugin provided in vite config');
  } else {
    // svite not included in vite config, add it now
    log.debug('adding svite plugin to vite');
    const svite = require(path.resolve(__dirname, '../index.js'));
    const svitePlugin = svite(options);
    viteConfig = resolvePlugin(viteConfig, svitePlugin);
  }

  optimizeViteConfig(viteConfig);
  return viteConfig;
}

function optimizeViteConfig(viteConfig) {
  log.debug('disabling vue support in vite');
  viteConfig.enableRollupPluginVue = false;
  viteConfig.vueCompilerOptions = {};
  viteConfig.vueTransformAssetUrls = {};
  viteConfig.vueCustomBlockTransforms = {};
}

function resolvePlugin(config, plugin) {
  return {
    ...config,
    ...plugin,
    alias: {
      ...plugin.alias,
      ...config.alias,
    },
    define: {
      ...plugin.define,
      ...config.define,
    },
    transforms: [...(config.transforms || []), ...(plugin.transforms || [])],
    resolvers: [...(config.resolvers || []), ...(plugin.resolvers || [])],
    configureServer: [].concat(config.configureServer || [], plugin.configureServer || []),
    vueCompilerOptions: {},
    vueTransformAssetUrls: {},
    vueCustomBlockTransforms: {},
    rollupInputOptions: mergeRollupOptions(config.rollupInputOptions, plugin.rollupInputOptions),
    rollupOutputOptions: mergeRollupOptions(config.rollupOutputOptions, plugin.rollupOutputOptions),
    enableRollupPluginVue: false,
  };
}

function mergeRollupOptions(rollupOptions1, rollupOptions2) {
  if (!rollupOptions1) {
    return rollupOptions2;
  }
  if (!rollupOptions2) {
    return rollupOptions1;
  }
  return {
    ...rollupOptions1,
    ...rollupOptions2,
    plugins: [...(rollupOptions1.plugins || []), ...(rollupOptions2.plugins || [])],
  };
}

async function runServe(options) {
  const start = Date.now();
  const server = vite.createServer(options);
  process.once('SIGTERM', () => stopServerAndExit(server, 'SIGTERM'));
  process.once('SIGINT', () => stopServerAndExit(server, 'SIGINT'));
  let port = options.port || 3000;
  let hostname = options.hostname || 'localhost';
  const protocol = options.https ? 'https' : 'http';
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log.warn(`Port ${port} is in use, trying another one...`);
      setTimeout(() => {
        server.close();
        server.listen(++port);
      }, 100);
    } else {
      log.error('server error', e);
    }
  });
  await server.listen(port, () => {
    log.info(`  Dev server running at:`);
    const interfaces = os.networkInterfaces();
    Object.keys(interfaces).forEach((key) => {
      (interfaces[key] || [])
        .filter((details) => details.family === 'IPv4')
        .map((detail) => {
          return {
            type: detail.address.includes('127.0.0.1') ? 'Local:   ' : 'Network: ',
            host: detail.address.replace('127.0.0.1', hostname),
          };
        })
        .forEach(({ type, host }) => {
          const url = `${protocol}://${host}:${chalk.bold(port)}/`;
          log.info(`  > ${type} ${chalk.cyan(url)}`);
        });
    });
    log.debug(`server ready in ${Date.now() - start}ms.`);
    if (options.open) {
      require('vite/dist/node/utils/openBrowser').openBrowser(`${protocol}://${hostname}:${port}`);
    }
  });
}

function stopServerAndExit(server, signal) {
  log.debug.enabled && log.debug(`received ${signal}, stopping server`);
  const graceSeconds = 3;
  setTimeout(() => {
    log.debug.enabled && log.debug(`server did not stop within ${graceSeconds}s. Exiting the hard way.`);
    process.exit(1);
  }, graceSeconds * 1000);
  server.close(() => {
    log.debug.enabled && log.debug('server stopped. bye');
    process.exit(0);
  });
}

async function runBuild(options) {
  try {
    if (options.ssr) {
      await vite.ssrBuild({
        ...options,
        ssr: false,
        outDir: !options.outDir || options.outDir === buildOptionDefaults.outDir ? 'dist-ssr' : options.outDir,
        assetsDir: !options.assetsDir || options.assetsDir === buildOptionDefaults.assetsDir ? '.' : options.assetsDir,
      });
    } else {
      await vite.build(options);
    }
    process.exit(0);
  } catch (err) {
    log.error('build error', err);
    process.exit(1);
  }
}

async function runOptimize(options) {
  try {
    options.configureServer[0]({ config: options }); //hack, call configureServer hook of plugin to get optimizeDeps populated
    await vite.optimizeDeps(options, true);
    process.exit(0);
  } catch (err) {
    log.error('optimize error', err);
    process.exit(1);
  }
}

function setupDebug(options) {
  const debugOption = options.debug;
  if (debugOption) {
    if (!process.env.DEBUG) {
      process.env.DEBUG = debugOption === 'true' || debugOption === true ? 'vite:*,svite:*' : `${debugOption}`;
    }
    options.logLevel = 'debug';
  }
  log = require('../tools/log');
  if (debugOption) {
    log.setLevel('debug');
  }
}
const templates = ['minimal', 'routify-mdsvex', 'postcss-tailwind', 'svelte-preprocess-auto'];
async function installTemplate(options) {
  const template = options.template;

  if (!templates.includes(template)) {
    log.error(`invalid template ${template}. Valid: ${JSON.stringify(templates)}`);
    return;
  }
  const targetDir = path.join(process.cwd(), options.targetDir || `svite-${template}`);

  const degit = require('degit');
  const githubRepo = pkg.repository.url.match(/github\.com\/(.*).git/)[1];
  const beta = pkg.version.indexOf('beta') > -1;
  const degitPath = `${githubRepo}/examples/${template}${beta ? '#beta' : ''}`;
  const degitOptions = {
    cache: options.cache,
    force: options.force,
    verbose: options.debug,
    mode: 'tar',
  };
  if (options.debug) {
    log.debug(`degit ${degitPath}`, degitOptions);
  }
  const emitter = degit(degitPath, degitOptions);

  emitter.on('info', (info) => {
    log.info(info.message);
  });
  emitter.on('warn', (warning) => {
    log.warn(warning.message);
  });
  emitter.on('error', (error) => {
    log.error(error.message, error);
  });

  await emitter.clone(targetDir);
  log.info(`created ${targetDir}`);
  await updatePkg(targetDir);
  if (!options.skipInstall) {
    await npmInstall(targetDir);
  }

  if (!options.skipGit) {
    await gitInit(targetDir);
    if (!options.skipCommit) {
      await gitCommit(targetDir);
    }
  }
}

async function updatePkg(dir) {
  const pkgFile = path.join(dir, 'package.json');
  const pkg = require(pkgFile);
  pkg.name = path.basename(dir);
  pkg.devDependencies.svite = `^${version}`;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
}

async function npmInstall(dir) {
  try {
    await execa('npm', ['install'], { cwd: dir });
  } catch (e) {
    console.error(`npm install failed in ${dir}`, e);
    throw e;
  }
}

async function gitInit(dir) {
  try {
    await execa('git', ['init'], { cwd: dir });
  } catch (e) {
    console.error(`git init failed in ${dir}`, e);
    throw e;
  }
}

async function gitCommit(dir) {
  try {
    await execa('git', ['add', '.'], { cwd: dir });
    await execa('git', ['commit', '-m "initial commit"'], { cwd: dir });
  } catch (e) {
    console.error(`git commit failed in ${dir}`, e);
    throw e;
  }
}

function removeDefaults(options, defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (options[key] === value) {
      delete options[key];
    }
  }
}

async function main() {
  program.version(version, '-v, --version').description('svite - build svelte apps with vite');

  program
    .command('dev', { isDefault: true })
    .description('start dev server')
    .option(
      '-d,  --debug [boolean|string]',
      'enable debug output. you can use true for "vite:*,svite:*" or supply your own patterns. Separate patterns with , start with - to filter. eg: "foo:*,-foo:bar" ',
      false,
    )
    .option('-c,  --config [string]', 'use specified vite config file')
    .option('-p,  --port [port]', 'port to use for serve', 3000)
    .option('-sw, --serviceWorker [boolean]', 'enable service worker caching', devOptionDefaults.serviceWorker)
    .option('-o,  --open [boolean]', 'open browser on start')
    .action(async (cmd) => {
      const options = cmd.opts();
      setupDebug(options);
      removeDefaults(options, devOptionDefaults);
      options.mode = 'development';
      await runServe(await setupSvite(options));
    });

  program
    .command('build')
    .description('build')
    .option(
      '-d, --debug [boolean|string]',
      'enable debug output. you can use true for "vite:*,svite:*" or supply your own patterns. Separate patterns with , start with - to filter. eg: "foo:*,-foo:bar" ',
      false,
    )
    .option('-c, --config [string]', 'use specified vite config file')
    .option('-m, --mode [string]', 'specify env mode', buildOptionDefaults.mode)
    .option('--base [string]', 'public base path for build', buildOptionDefaults.base)
    .option('--outDir [string]', 'output directory for build', buildOptionDefaults.outDir)
    .option('--assetsDir [string]', 'directory under outDir to place assets in', buildOptionDefaults.assetsDir)
    .option('--assetsInlineLimit [number]', 'static asset base64 inline threshold in bytes', buildOptionDefaults.assetsInlineLimit)
    .option('--sourcemap [boolean]', 'output source maps for build', buildOptionDefaults.sourcemap)
    .option(
      '--minify [boolean | "terser" | "esbuild"]',
      'enable/disable minification, or specify minifier to use.',
      buildOptionDefaults.minify,
    )
    .option(
      '--stats [boolean|string]',
      'generate bundle stats with rollup-plugin-visualizer. true, "json": stats.json, ["html" "treemap","sunburst","network"]: stats.html',
    )
    .option('--ssr [boolean]', 'build for server-side rendering')
    .action(async (cmd) => {
      const options = cmd.opts();
      setupDebug(options);
      removeDefaults(options, buildOptionDefaults);
      const buildOptions = await setupSvite(options);
      if (options.stats) {
        try {
          const visualizer = require('rollup-plugin-visualizer');
          const visualizerOptions = {};
          if (options.stats === true || options.stats === 'json') {
            visualizerOptions.json = true;
          } else if (options.stats === 'html') {
            visualizerOptions.template = 'treemap';
          } else if (['treemap', 'sunburst', 'network'].includes(options.stats)) {
            visualizerOptions.template = options.stats;
          } else {
            throw new Error(`invalid value for stats option: ${options.stats}`);
          }
          visualizerOptions.filename = path.join(options.outDir, `stats.${visualizerOptions.json ? 'json' : 'html'}`);
          buildOptions.rollupInputOptions.plugins.push(visualizer(visualizerOptions));
        } catch (e) {
          log.error('stats option requires rollup-plugin-visualizer to be installed', e);
          throw e;
        }
      }
      await runBuild(buildOptions);
    });

  program
    .command('optimize')
    .description('run vite optimizer')
    .option(
      '-d, --debug [boolean|string]',
      'enable debug output. you can use true for "vite:*,svite:*" or supply your own patterns. Separate patterns with , start with - to filter. eg: "foo:*,-foo:bar" ',
      false,
    )
    .option('-c, --config [string]', 'use specified vite config file')
    .option('-f, --force', 'force optimize even if hash is equal')
    .action(async (cmd) => {
      const options = cmd.opts();
      setupDebug(options);
      const buildConfig = await setupSvite(options);
      if (options.force) {
        buildConfig.force = true;
      }
      await runOptimize(buildConfig);
    });

  program
    .command('create [targetDir]')
    .description('create a new project. If you do not specify targetDir, "./svite-<template>" will be used')
    .option('-t, --template [string]', `template for new project. ${JSON.stringify(templates)}`, 'minimal')
    .option('-f, --force', 'force operation even if targetDir exists and is not empty', false)
    .option('-c, --cache', 'cache template for later use', false)
    .option('-d, --debug', 'more verbose logging', false)
    .option('-si, --skip-install', 'skip npm install', false)
    .option('-sg, --skip-git', 'skip git init', false)
    .option('-sc, --skip-commit', 'skip initial commit', false)
    .action(async (targetDir, cmd) => {
      const options = cmd.opts();
      setupDebug(options);
      options.targetDir = targetDir;
      await installTemplate(options);
    });
  await program.parseAsync(process.argv);
}

main()
  .then(() => {
    log.debug('command success');
  })
  .catch((e) => {
    log.error('command error', e);
    process.exit(1);
  });
