// Script for public/permission.html. Chrome does not show the microphone prompt inside a
// side panel, so this page asks once in a normal tab. The grant then covers the panel.

import { say } from './localVoice';

const message = document.querySelector<HTMLParagraphElement>('#message')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;

function announce(text: string): void {
  message.textContent = text;
  say(text);
}

async function request(): Promise<void> {
  announce(
    'Chrome is asking whether Assista may use the microphone. Choose Allow so you can talk to Assista.',
  );
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    announce('The microphone is ready. This tab will close.');
    setTimeout(() => window.close(), 2500);
  } catch {
    announce(
      'Assista could not get the microphone. Allow it in the site settings for this page, then press the Ask again button.',
    );
  }
}

retry.addEventListener('click', () => void request());
void request();
