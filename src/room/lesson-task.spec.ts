import { Doc } from 'yjs';
import { insertLessonTemplate, LessonTask } from './lesson-task';

const task: LessonTask = {
  title: 'Задача', description: 'Условие', moduleId: 1, language: 'py',
  initialCode: 'def run():\n    return 1', input: '', after: 'print(run())',
};

it('places the personal task prompt between starter code and the final fragment', () => {
  const doc = new Doc();
  const text = doc.getText('codemirror');
  text.insert(0, task.initialCode);
  insertLessonTemplate(text, task);
  expect(text.toString()).toBe('def run():\n    return 1\n\n# Напишите код здесь\n\nprint(run())');
  doc.destroy();
});

it('keeps the platform prompt above the editable solution', () => {
  const doc = new Doc();
  const text = doc.getText('codemirror');
  text.insert(0, task.initialCode);
  insertLessonTemplate(text, { ...task, platformId: 1, before: '# Пример' });
  expect(text.toString()).toBe('# Пример\n# Напишите код здесь\ndef run():\n    return 1\n\nprint(run())');
  doc.destroy();
});
