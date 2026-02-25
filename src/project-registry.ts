import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import type { Project } from './types.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

export class ProjectRegistry {
  private projects: Project[] = [];

  constructor() {
    this.load();
  }

  getAll(): Project[] {
    return [...this.projects];
  }

  getById(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  add(name: string, projectPath: string, description?: string): Project {
    const project: Project = {
      id: randomUUID(),
      name,
      path: projectPath,
      description,
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  remove(id: string): boolean {
    const len = this.projects.length;
    this.projects = this.projects.filter((p) => p.id !== id);
    if (this.projects.length < len) {
      this.save();
      return true;
    }
    return false;
  }

  private load(): void {
    try {
      const raw = readFileSync(PROJECTS_FILE, 'utf-8');
      this.projects = JSON.parse(raw);
    } catch {
      this.projects = [];
    }
  }

  private save(): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PROJECTS_FILE, JSON.stringify(this.projects, null, 2));
  }
}
