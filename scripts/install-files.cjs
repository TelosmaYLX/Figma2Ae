'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const source = path.resolve(__dirname, '..');
const manifestFile = 'package-manifest.json';
const pathKey = file => path.resolve(file).toLowerCase();

async function stat(file) {
  try { return await fs.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function managedPath(directory, file) {
  const result = path.resolve(directory, file);
  const relative = path.relative(directory, result);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || file.includes(':')) {
    throw new Error('Invalid package path: ' + file);
  }
  return result;
}

const packagePaths = manifest => (manifest?.files || []).map(entry => entry.path.replaceAll('\\', '/'));
const skillPaths = files => files.filter(file => /^skills\/[^/]+\/.+/.test(file)).map(file => file.slice('skills/'.length));

async function skillDirectories(previous, requested, incomingSkills) {
  const profile = process.env.USERPROFILE || os.homedir();
  const agentHome = (variable, name) => (process.env[variable] || path.join(profile, name)).replace(/^~(?=[\\/]|$)/, profile);
  const shared = path.join(profile, '.agents');
  const commonAgents = [agentHome('CODEX_HOME', '.codex'), path.join(profile, '.cursor'), path.join(profile, '.gemini')];
  const skillNames = [...new Set(incomingSkills.map(file => file.split('/')[0]))];
  const directories = new Map();
  const add = directory => directories.set(pathKey(directory), path.resolve(directory));
  for (const directory of previous) if ((await stat(directory))?.isDirectory()) add(directory);
  for (const home of [shared, ...commonAgents]) {
    if ((await stat(home))?.isDirectory()) add(path.join(shared, 'skills'));
  }
  for (const home of [agentHome('DSH_HOME', '.dsh'), agentHome('CLAUDE_CONFIG_DIR', '.claude')]) {
    if ((await stat(home))?.isDirectory()) add(path.join(home, 'skills'));
  }
  // Also update existing copies in an agent's earlier personal skill location.
  for (const home of commonAgents) {
    const directory = path.join(home, 'skills');
    for (const name of skillNames) {
      if ((await stat(path.join(directory, name, 'SKILL.md')))?.isFile()) {
        add(directory);
        break;
      }
    }
  }
  if (requested) add(requested);
  return [...directories.values()];
}

async function planFiles(from, to, incoming, previous) {
  const copies = [];
  const wanted = new Set();
  for (const file of incoming) {
    const input = managedPath(from, file);
    const output = managedPath(to, file);
    if (!(await stat(input))?.isFile()) throw new Error('Package file is missing: ' + file);
    wanted.add(pathKey(output));
    if (pathKey(input) !== pathKey(output)) copies.push({root: to, output, input});
  }
  const removals = previous.map(file => managedPath(to, file)).filter(file => !wanted.has(pathKey(file)));
  return [...removals.map(output => ({root: to, output})), ...copies];
}

async function pruneEmptyParents(file, root) {
  for (let directory = path.dirname(file); pathKey(directory) !== pathKey(root); directory = path.dirname(directory)) {
    try { await fs.rmdir(directory); }
    catch (error) {
      if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function replaceFile(output, input, contents) {
  const directory = path.dirname(output);
  await fs.mkdir(directory, {recursive: true});
  const staged = path.join(directory, '.f2a-' + randomUUID());
  try {
    if (input) await fs.copyFile(input, staged);
    else await fs.writeFile(staged, contents);
    await fs.rename(staged, output);
  } finally {
    await fs.rm(staged, {force: true});
  }
}

async function apply(plan) {
  const backupDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-install-'));
  const applied = [];
  let restored = true;
  try {
    for (const {root, output, input, contents} of plan) {
      // A linked directory may point outside this installation. Do not mutate its target.
      for (let directory = path.dirname(output); pathKey(directory) !== pathKey(root); directory = path.dirname(directory)) {
        if ((await stat(directory))?.isSymbolicLink()) throw new Error('Cannot synchronize through a linked directory: ' + directory);
      }
      const before = await stat(output);
      const remove = !input && contents === undefined;
      if (remove && !before?.isFile()) continue;
      if (before && !before.isFile()) throw new Error('Expected a file at ' + output);
      const backup = before && path.join(backupDirectory, String(applied.length));
      if (backup) await fs.copyFile(output, backup);
      if (remove) await fs.unlink(output);
      else await replaceFile(output, input, contents);
      applied.push({root, output, backup});
      if (remove) await pruneEmptyParents(output, root);
    }
  } catch (error) {
    try {
      for (const {root, output, backup} of applied.reverse()) {
        if (backup) await replaceFile(output, backup);
        else {
          await fs.unlink(output);
          await pruneEmptyParents(output, root);
        }
      }
    } catch (rollbackError) {
      restored = false;
      throw new Error(error.message + '\nRollback failed: ' + rollbackError.message + '\nBackups: ' + backupDirectory);
    }
    throw error;
  } finally {
    if (restored && pathKey(path.dirname(backupDirectory)) === pathKey(os.tmpdir())) {
      await fs.rm(backupDirectory, {recursive: true, force: true});
    }
  }
}

async function install(directory, requestedSkillDirectory) {
  const target = path.resolve(directory);
  if (await stat(path.join(target, '.git'))) throw new Error('Choose a CEP install directory for the F2A package.');
  const output = path.join(target, manifestFile);
  const incoming = JSON.parse(await fs.readFile(path.join(source, manifestFile), 'utf8'));
  const previous = await stat(output) ? JSON.parse(await fs.readFile(output, 'utf8')) : null;
  if (previous && previous.name !== incoming.name) throw new Error('The installation directory belongs to another package.');
  const files = packagePaths(incoming), oldFiles = packagePaths(previous);
  const skills = skillPaths(files), oldSkills = skillPaths(oldFiles);
  const previousDirectories = previous?.skillDirectories || [];
  const previousKeys = new Set(previousDirectories.map(pathKey));
  const skillSource = path.join(source, 'skills');
  const directories = (await skillDirectories(previousDirectories, requestedSkillDirectory, skills))
    .filter(directory => pathKey(directory) !== pathKey(path.join(target, 'skills')));

  const plan = await planFiles(source, target, files, oldFiles);
  for (const directory of directories) {
    plan.push(...await planFiles(skillSource, directory, skills, previousKeys.has(pathKey(directory)) ? oldSkills : []));
  }
  plan.push({root: target, output, contents: JSON.stringify({...incoming, skillDirectories: directories}, null, 2) + '\n'});
  await apply(plan);
  for (const directory of directories) console.log('Skills synchronized: ' + directory);
}

install(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
