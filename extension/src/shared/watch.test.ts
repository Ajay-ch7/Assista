import { describe, expect, it } from 'vitest';
import {
  alertText,
  describeCondition,
  matchWatches,
  numberIn,
  pageAddress,
  parseCondition,
  summarize,
  watchFires,
  type Watch,
  type WatchCondition,
} from './watch';

function watch(lastValue: string, condition: WatchCondition, extra: Partial<Watch> = {}): Watch {
  return {
    id: 'w1',
    url: 'https://shop.test/bag',
    pageTitle: 'Trail Backpack - Riverside',
    selector: '.price',
    label: 'the price',
    lastValue,
    condition,
    alert: '',
    createdAt: 0,
    ...extra,
  };
}

describe('numberIn', () => {
  it.each([
    ['Price: 4,499 rupees', 4499],
    ['₹4,499.50', 4499.5],
    ['3 left in stock', 3],
    ['-2 degrees', -2],
    ['Sold out', null],
  ])('reads %s as %s', (text, expected) => {
    expect(numberIn(text)).toBe(expected);
  });
});

describe('parseCondition', () => {
  it('reads the kinds the model may ask for', () => {
    expect(parseCondition('decreases', undefined)).toEqual({ kind: 'decreases' });
    expect(parseCondition('below', 4000)).toEqual({ kind: 'below', value: 4000 });
    expect(parseCondition('above', '5,000 rupees')).toEqual({ kind: 'above', value: 5000 });
    expect(parseCondition('contains', ' In stock ')).toEqual({
      kind: 'contains',
      text: 'In stock',
    });
  });

  it('falls back to any change when the request is unclear', () => {
    expect(parseCondition('cheaper', undefined)).toEqual({ kind: 'changes' });
    expect(parseCondition('below', 'a bit')).toEqual({ kind: 'changes' });
    expect(parseCondition('contains', '')).toEqual({ kind: 'changes' });
    expect(parseCondition(undefined, undefined)).toEqual({ kind: 'changes' });
  });
});

describe('watchFires', () => {
  it('never fires while the value stays the same', () => {
    expect(watchFires(watch('4,499 rupees', { kind: 'changes' }), '4,499 rupees')).toBe(false);
  });

  it('fires on any change', () => {
    expect(watchFires(watch('4,499 rupees', { kind: 'changes' }), '4,299 rupees')).toBe(true);
    expect(watchFires(watch('Sold out', { kind: 'changes' }), 'In stock')).toBe(true);
  });

  it('tells a fall from a rise', () => {
    const falls = watch('Price: 4,499 rupees', { kind: 'decreases' });
    expect(watchFires(falls, 'Price: 3,999 rupees')).toBe(true);
    expect(watchFires(falls, 'Price: 4,999 rupees')).toBe(false);
    expect(watchFires(falls, 'Price on request')).toBe(false);
    const rises = watch('3 seats', { kind: 'increases' });
    expect(watchFires(rises, '5 seats')).toBe(true);
    expect(watchFires(rises, '1 seat')).toBe(false);
  });

  it('fires when a threshold is crossed', () => {
    const below = watch('4,499 rupees', { kind: 'below', value: 4000 });
    expect(watchFires(below, '4,100 rupees')).toBe(false);
    expect(watchFires(below, '3,999 rupees')).toBe(true);
    const above = watch('2 seats left', { kind: 'above', value: 3 });
    expect(watchFires(above, '4 seats left')).toBe(true);
    expect(watchFires(above, '3 seats left')).toBe(false);
  });

  it('fires when wanted words appear, once', () => {
    const stock = watch('Sold out', { kind: 'contains', text: 'in stock' });
    expect(watchFires(stock, 'Back In Stock today')).toBe(true);
    expect(watchFires(stock, 'Coming soon')).toBe(false);
    const already = watch('In stock: 2', { kind: 'contains', text: 'in stock' });
    expect(watchFires(already, 'In stock: 5')).toBe(false);
  });
});

describe('alertText', () => {
  it('fills in the new and old values', () => {
    const w = watch(
      '4,499 rupees',
      { kind: 'changes' },
      { alert: 'The price is now {value}, down from {old}' },
    );
    expect(alertText(w, '3,999 rupees')).toBe(
      'The price is now 3,999 rupees, down from 4,499 rupees.',
    );
  });

  it('has a plain sentence when no wording was given', () => {
    expect(alertText(watch('Sold out', { kind: 'changes' }), 'In stock')).toBe(
      'the price changed from Sold out to In stock.',
    );
  });
});

describe('summaries and matching', () => {
  const price = watch('4,499 rupees', { kind: 'below', value: 4000 });
  const seats = watch(
    '2 seats',
    { kind: 'changes' },
    {
      id: 'w2',
      label: 'seats left',
      pageTitle: 'Book a table',
      url: 'https://food.test/book',
    },
  );

  it('describes a watch in words', () => {
    expect(summarize(price)).toEqual({
      id: 'w1',
      label: 'the price',
      page: 'Trail Backpack - Riverside',
      condition: 'goes below 4000',
      value: '4,499 rupees',
    });
    expect(describeCondition({ kind: 'contains', text: 'in stock' })).toBe('says in stock');
    expect(describeCondition({ kind: 'decreases' })).toBe('goes down');
  });

  it('finds watches by label, page or id, and all of them without a query', () => {
    expect(matchWatches([price, seats], 'price')).toEqual([price]);
    expect(matchWatches([price, seats], 'the table booking')).toEqual([seats]);
    expect(matchWatches([price, seats], 'w2')).toEqual([seats]);
    expect(matchWatches([price, seats], '')).toEqual([price, seats]);
    expect(matchWatches([price, seats], 'flights')).toEqual([]);
  });

  it('files a page under its address without the fragment', () => {
    expect(pageAddress('https://shop.test/bag?x=1#reviews')).toBe('https://shop.test/bag?x=1');
    expect(pageAddress('https://shop.test/bag')).toBe('https://shop.test/bag');
  });
});
