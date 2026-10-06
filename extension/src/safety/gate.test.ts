// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { gateCheck } from './gate';

function control(html: string, selector = 'button, a, input'): Element {
  document.body.innerHTML = html;
  return document.body.querySelector(selector)!;
}

describe('gateCheck', () => {
  it.each([
    'Pay',
    'Pay now',
    'Proceed to pay',
    'Buy now',
    'Purchase',
    'Place order',
    'Place your order',
    'Submit',
    'Submit application',
    'Confirm booking',
    'Delete account',
    'Send',
    'SEND MESSAGE',
  ])('holds a control that reads "%s"', (name) => {
    expect(gateCheck(control(`<button type="button">${name}</button>`), name)).toEqual({
      control: name,
      reason: 'risky_control',
    });
  });

  it.each([
    'Add to cart',
    'Go to checkout',
    'Next',
    'Continue',
    'Buying guide',
    'Payment options',
    'Sender details',
    'Read more',
    'Close',
  ])('lets a control that reads "%s" through', (name) => {
    expect(gateCheck(control(`<button type="button">${name}</button>`), name)).toBeNull();
  });

  it('holds links as well as buttons', () => {
    const link = control('<a href="/delete">Delete my account</a>');
    expect(gateCheck(link, 'Delete my account')?.reason).toBe('risky_control');
  });

  it('reads the wording the name leaves out', () => {
    const titled = control('<button type="button" title="Pay with card">Continue</button>');
    expect(gateCheck(titled, 'Continue')?.reason).toBe('risky_control');
    const hidden = control(
      '<button type="button">Next<span style="display:none"> and place order</span></button>',
    );
    expect(gateCheck(hidden, 'Next')?.reason).toBe('risky_control');
  });

  it('holds every form submission, whatever the button says', () => {
    const cases = [
      '<form><button>Continue</button></form>',
      '<form><button type="submit">Search</button></form>',
      '<form><input type="submit" value="Go"></form>',
      '<form><input type="image" alt="Next" src="next.png"></form>',
      '<form id="f"></form><button form="f">Sign in</button>',
    ];
    for (const html of cases) {
      expect(gateCheck(control(html), 'x')).toEqual({ control: 'x', reason: 'form_submit' });
    }
  });

  it('lets buttons that do not submit through, inside a form or not', () => {
    expect(
      gateCheck(control('<form><button type="button">Show more</button></form>'), 'Show more'),
    ).toBeNull();
    expect(
      gateCheck(control('<form><button type="reset">Clear</button></form>'), 'Clear'),
    ).toBeNull();
    expect(gateCheck(control('<button>Continue</button>'), 'Continue')).toBeNull();
    expect(gateCheck(control('<form><input type="checkbox"></form>'), 'Gift wrap')).toBeNull();
  });

  it('names an unnamed control for the read-back', () => {
    expect(gateCheck(control('<form><button></button></form>'), '')?.control).toBe('this control');
  });
});
