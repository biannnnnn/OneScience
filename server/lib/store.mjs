import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const storageDir = path.resolve(currentDir, '../storage');
const storageFile = path.join(storageDir, 'projects.json');

async function readAll() {
  await mkdir(storageDir, { recursive: true });
  try {
    const raw = await readFile(storageFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeAll(projects) {
  await mkdir(storageDir, { recursive: true });
  const temporary = `${storageFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(projects, null, 2)}\n`, 'utf8');
  await rename(temporary, storageFile);
}

export async function listProjects() {
  const projects = await readAll();
  return projects
    .map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
      stage: project.stage,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      document: project.document
        ? {
            title: project.document.title,
            filename: project.document.filename,
            fileType: project.document.fileType,
          }
        : null,
    }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getProject(id) {
  return (await readAll()).find((project) => project.id === id) ?? null;
}

export async function saveProject(project) {
  const projects = await readAll();
  const index = projects.findIndex((item) => item.id === project.id);
  if (index >= 0) projects[index] = project;
  else projects.push(project);
  await writeAll(projects);
  return project;
}

export async function patchProject(id, patch) {
  const projects = await readAll();
  const index = projects.findIndex((project) => project.id === id);
  if (index < 0) return null;
  projects[index] = {
    ...projects[index],
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
  };
  await writeAll(projects);
  return projects[index];
}
