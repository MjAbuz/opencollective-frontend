import loadScript from 'load-script';

export function truncate(str, length) {
  if (!str || typeof str !== 'string' || str.length <= length) {
    return str;
  }
  const subString = str.substr(0, length - 1);
  return `${subString.substr(0, subString.lastIndexOf(' '))} …`;
}

/**
 * Validate a relative path.
 * > isValidRelativeUrl('a/b/c/d/e/f/g')
 * true
 * > isValidRelativeUrl('about.html')
 * true
 * > isValidRelativeUrl('//')
 * false
 * > isValidRelativeUrl('https://google.com')
 * false
 */
export const isValidRelativeUrl = url => {
  return Boolean(url.match(/^[^/]*\/[^/].*$|^\/[^/].*$/));
};

export const isValidEmail = email => {
  if (typeof email !== 'string') {
    return false;
  }
  return email.match(
    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
  );
};

export function parseToBoolean(value) {
  let lowerValue = value;
  // check whether it's string
  if (lowerValue && (typeof lowerValue === 'string' || lowerValue instanceof String)) {
    lowerValue = lowerValue.trim().toLowerCase();
  }
  if (['on', 'enabled', '1', 'true', 'yes', 1].includes(lowerValue)) {
    return true;
  }
  return false;
}

export function getQueryParams() {
  const urlParams = {};
  let match;
  const pl = /\+/g, // Regex for replacing addition symbol with a space
    search = /([^&=]+)=?([^&]*)/g,
    decode = function (s) {
      return decodeURIComponent(s.replace(pl, ' '));
    },
    query = window.location.search.substring(1);

  // eslint-disable-next-line no-cond-assign
  while ((match = search.exec(query))) {
    urlParams[decode(match[1])] = decode(match[2]);
  }
  return urlParams;
}

export function formatDate(date, options = { month: 'long', year: 'numeric' }) {
  const d = new Date(date);
  const locale = typeof window !== 'undefined' ? window.navigator.language : options.locale || 'en-US';
  try {
    return d.toLocaleDateString(locale, options);
  } catch {
    try {
      return d.toLocaleDateString('en-US', options);
    } catch {
      return d.toString();
    }
  }
}

export const singular = str => {
  if (!str) {
    return '';
  }
  return str.replace(/ies$/, 'y').replace(/s$/, '');
};

export const getBaseApiUrl = ({ internal } = {}) => {
  if (process.browser) {
    return '/api';
  } else if (internal && process.env.INTERNAL_API_URL) {
    return process.env.INTERNAL_API_URL;
  } else {
    return process.env.API_URL || 'https://api.opencollective.com';
  }
};

/**
 * Returns the GraphQL api url for the appropriate api version and environment.
 * @param {string} version - api version. Defaults to v1.
 * @returns {string} GraphQL api url.
 */
export const getGraphqlUrl = apiVersion => {
  const apiKey = !process.browser ? process.env.API_KEY : null;
  return `${getBaseApiUrl()}/graphql${apiVersion ? `/${apiVersion}` : ''}${apiKey ? `?api_key=${apiKey}` : ''}`;
};

export const capitalize = str => {
  if (typeof str !== 'string') {
    return '';
  }
  str = str.trim();
  if (str.length === 0) {
    return '';
  }
  return `${str[0].toUpperCase()}${str.substr(1)}`;
};

const trim = (str, length) => {
  if (!str) {
    return '';
  }

  if (str.length <= length) {
    return str;
  }

  const res = [];
  let res_length = 0;
  const words = str.split(' ');
  let i = 0;
  while (res_length < length && i < words.length) {
    const w = words[i++];
    res_length += w.length + 1;
    res.push(w);
  }
  return `${res.join(' ')} …`;
};

export const firstSentence = (str, length) => {
  if (!str) {
    return '';
  }

  str = str.replace(/&amp;/g, '&');

  if (str.length <= length) {
    return str;
  }
  const tokens = str.match(/\.|\?|!/);
  if (tokens) {
    str = str.substr(0, tokens.index + 1);
  }
  str = trim(str, length);
  return str;
};

export const loadScriptAsync = (url, opts = {}) =>
  new Promise((resolve, reject) => {
    loadScript(url, opts, (err, script) => {
      if (err) {
        reject(err);
      } else {
        resolve(script);
      }
    });
  });

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#Using_special_characters
// From section about escapting user input
export const escapeInput = string => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getWebsiteUrl = () => {
  if (typeof window !== 'undefined' && window.location) {
    return `${window.location.protocol}//${window.location.host}`;
  } else {
    return process.env.WEBSITE_URL;
  }
};

export function compose(...funcs) {
  const functions = funcs.reverse();
  return function (...args) {
    const [firstFunction, ...restFunctions] = functions;
    let result = firstFunction.apply(null, args);
    restFunctions.forEach(fnc => {
      result = fnc.call(null, result);
    });
    return result;
  };
}

/** This function will return true if reportValidity is not supported by the browser, or if it succeed */
export const reportValidityHTML5 = domNodeOrEvent => {
  return !domNodeOrEvent || !domNodeOrEvent.reportValidity || domNodeOrEvent.reportValidity();
};

/**
 * Repeat `func` for `nbTimes`, calling it every `interval` ms.
 * Passes one parameter: the number of iterations left.
 */
export const repeatWithInterval = (nbTimes, interval, func) => {
  func(nbTimes);
  if (nbTimes - 1 > 0) {
    setTimeout(() => repeatWithInterval(nbTimes - 1, interval, func), interval);
  }
};

/**
 * Similar to `Promise.allSettled` (which doesn't have a great browser support yet)
 */
export const allSettled = promises => {
  return Promise.all(
    promises.map(promise => {
      return Promise.resolve(promise).then(
        val => ({ status: 'fulfilled', value: val }),
        err => ({ status: 'rejected', reason: err }),
      );
    }),
  );
};
