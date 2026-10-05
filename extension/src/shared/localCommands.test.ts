import { describe, expect, it } from 'vitest';
import { normalizeCommand, parseLocalCommand } from './localCommands';

describe('parseLocalCommand', () => {
  it.each([
    ['Stop.', { kind: 'stop' }],
    ['Assista, stop talking', { kind: 'stop' }],
    ['please repeat that', { kind: 'repeat' }],
    ['Say that again?', { kind: 'repeat' }],
    ['Slower please', { kind: 'slower' }],
    ['speed up', { kind: 'faster' }],
    ['Be brief.', { kind: 'verbosity', level: 'brief' }],
    ['normal detail', { kind: 'verbosity', level: 'normal' }],
    ['More detail, please.', { kind: 'verbosity', level: 'detailed' }],
    ['Spell it.', { kind: 'spell', text: null }],
    ['spell that again', { kind: 'spell', text: null }],
    ['Spell Kaveri.', { kind: 'spell', text: 'Kaveri' }],
    ['Assista, spell asha@example.com', { kind: 'spell', text: 'asha@example.com' }],
  ])('recognises %j', (text, command) => {
    expect(parseLocalCommand(text)).toEqual(command);
  });

  it.each([
    'stop the video on this page',
    'what does it say again about returns?',
    'describe the faster delivery option',
    'how do you spell relief?',
    'where am I?',
    '',
  ])('leaves %j for the backend', (text) => {
    expect(parseLocalCommand(text)).toBeNull();
  });
});

describe('normalizeCommand', () => {
  it('drops punctuation, case and filler words', () => {
    expect(normalizeCommand('  Hey Assista, could you REPEAT that, please?! ')).toBe('repeat that');
  });
});
