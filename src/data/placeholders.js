// Instant placeholders for the two scenes whose backdrop is a large file: a
// tiny (24-32px wide) blurred thumbnail embedded here as a data URI, plus the
// image's average colour. They are part of the JavaScript bundle, so they are
// on screen in the very first frame of the page, before any image or video
// has downloaded — so arriving on About or Services never shows black.
//
// Generated from the real files (About: the satin film's first frame;
// Services: public/services/velvet.webp). Regenerate if those change.

export const ABOUT_SATIN = {
  blur: 'data:image/webp;base64,UklGRgoBAABXRUJQVlA4IP4AAABwBgCdASogABIAPrVKnUmnJCKhMAgA4BaJYgCdMoQCwnMbVH0C6Y3aGqkr3k1uf8LQvun/1hbp5G2WKwAA/vK+o3DCuCkWd0EIsa1jJYiknPw/FFqI0cPD7/i5FAx3lkU0paX9paYAEylIz8Y1ZlIYmBW90QKrQtp8Xb8Nm4D5pYU9rAJia5U7D+kFm0IKYNVAQS1Po3hRUnO3njnhL5zwgvCMkyHkQZ5to0N6pwYcuHOqeyjuuWzoInCCEzPm2g3CRMGOSVdiDF1pV885FLV9vDRN+iUjKkE3ViAWWWRaPo4Z9HDioolhLL+eAVBDvamhjkiGyGM7ATJKsJbgAA==',
  colour: '#163e78',
}

export const SERVICES_VELVET = {
  blur: 'data:image/webp;base64,UklGRl4AAABXRUJQVlA4IFIAAADwAwCdASoYABYAPrVQoEwnJKMiKAqo4BaJZQCuHBbJJbwIEd2yS/AAAP7y+K/mUAoAIw0XLqiS3rEst8rhjsFM6GRTuvKTAnzXMaTcdWYGAAAA',
  colour: '#06162a',
}
