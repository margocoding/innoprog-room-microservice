import { Language } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

export interface LessonTask {
  title: string;
  description: string;
  descriptionFormat?: 'markdown';
  moduleId: number;
  language: Language;
  initialCode: string;
  input: string;
  output?: string;
  before?: string;
  after?: string;
  topic?: string;
  platformId?: number;
}

function field(value: unknown, max: number, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || (required && !value.trim())) {
    throw new BadRequestException('Проверьте заполнение полей задачи');
  }
  return value;
}

export function readLessonTask(value: unknown, platform = false): LessonTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Некорректная задача');
  const data = value as Record<string, unknown>;
  if (typeof data.moduleId !== 'number' || !Number.isSafeInteger(data.moduleId) || data.moduleId < 1 || data.moduleId > 2147483647 ||
      !Object.values(Language).includes(data.language as Language)) {
    throw new BadRequestException('Выберите модуль и язык');
  }
  const task: LessonTask = {
    title: field(data.title, 640, true).trim(),
    description: field(data.description, 48_000, true),
    moduleId: data.moduleId,
    language: data.language as Language,
    initialCode: field(data.initialCode, 32_000),
    input: field(data.input, 16_000),
  };
  if (data.descriptionFormat === 'markdown') task.descriptionFormat = 'markdown';
  if (data.output !== undefined || platform) task.output = field(data.output, 16_000);
  if (data.after !== undefined || platform) task.after = field(data.after, 32_000);
  if (platform) {
    task.before = field(data.before, 32_000);
    if (typeof data.platformId === 'number' && Number.isSafeInteger(data.platformId) && data.platformId > 0) task.platformId = data.platformId;
    task.topic = field(data.topic, 500);
  }
  return task;
}

const editorPrompt: Record<Language, string> = {
  py: '# Напишите код здесь',
  bash: '# Напишите код здесь',
  cpp: '// Напишите код здесь',
  java: '// Напишите код здесь',
  js: '// Напишите код здесь',
  dart: '// Напишите код здесь',
  sql: '-- Напишите код здесь',
  html: '<!-- Напишите код здесь -->',
};

export function insertLessonTemplate(text: import('yjs').Text, task: LessonTask | null) {
  if (!task || (!task.before && !task.after)) return;
  if (!task.platformId && !task.before && task.after) {
    const separator = text.length ? (text.toString().endsWith('\n') ? '\n' : '\n\n') : '';
    text.insert(text.length, separator + editorPrompt[task.language] + '\n\n' + task.after);
    return;
  }
  const opening = [task.before || undefined, editorPrompt[task.language], ''].filter(part => part !== undefined).join('\n');
  text.insert(0, opening);
  if (task.after) text.insert(text.length, '\n\n' + task.after);
}
