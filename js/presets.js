// 초보자도 한 번에 좋은 결과를 얻을 수 있도록 다듬어 둔 프리셋 모음

export const FILTERS = [
  { id: 'none', name: '원본', css: '' },
  { id: 'vivid', name: '선명하게', css: 'saturate(1.35) contrast(1.1)' },
  { id: 'bright', name: '화사하게', css: 'brightness(1.1) saturate(1.15) contrast(0.95)' },
  { id: 'warm', name: '따뜻하게', css: 'sepia(0.22) saturate(1.2) hue-rotate(-8deg)' },
  { id: 'cool', name: '시원하게', css: 'saturate(1.05) hue-rotate(10deg) brightness(1.03)' },
  { id: 'film', name: '필름', css: 'sepia(0.18) contrast(0.92) saturate(0.85) brightness(1.05)' },
  { id: 'cinema', name: '시네마', css: 'contrast(1.2) saturate(0.82) brightness(0.95)' },
  { id: 'vintage', name: '빈티지', css: 'contrast(0.85) brightness(1.1) saturate(0.7) sepia(0.2)' },
  { id: 'mono', name: '흑백', css: 'grayscale(1) contrast(1.15)' },
];
export const filterById = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

export const MOTIONS = [
  { id: 'none', name: '없음', desc: '움직임 없음' },
  { id: 'zoomIn', name: '천천히 확대', desc: '시선을 모으는 효과' },
  { id: 'zoomOut', name: '천천히 축소', desc: '여유로운 마무리' },
  { id: 'panLeft', name: '왼쪽으로', desc: '사진에 생동감' },
  { id: 'panRight', name: '오른쪽으로', desc: '사진에 생동감' },
];

export const TRANSITIONS = [
  { id: 'none', name: '바로 전환', desc: '컷' },
  { id: 'dissolve', name: '디졸브', desc: '부드럽게 겹치기' },
  { id: 'fade', name: '페이드', desc: '검은 화면 거쳐서' },
  { id: 'slide', name: '밀어내기', desc: '옆에서 들어옴' },
  { id: 'zoom', name: '줌', desc: '확대되며 등장' },
  { id: 'wipe', name: '와이프', desc: '닦아내듯 전환' },
];

export const TEXT_ANIMS = [
  { id: 'none', name: '없음' },
  { id: 'fade', name: '페이드' },
  { id: 'pop', name: '톡 튀어나오기' },
  { id: 'slideUp', name: '아래에서 위로' },
  { id: 'typewriter', name: '타자기' },
];

// size: 화면 높이 대비 글자 크기, x/y: 화면 대비 중심 위치(0~1)
export const TEXT_STYLES = [
  {
    id: 'subtitle', name: '기본 자막', sample: '자막',
    font: 'Noto Sans KR', weight: 700, size: 0.052, color: '#ffffff',
    stroke: '#000000', strokeW: 0.16, x: 0.5, y: 0.87, anim: 'none', shadow: true,
  },
  {
    id: 'box', name: '박스 자막', sample: '자막',
    font: 'Noto Sans KR', weight: 700, size: 0.048, color: '#ffffff',
    bg: 'rgba(0,0,0,0.62)', x: 0.5, y: 0.87, anim: 'fade',
  },
  {
    id: 'title', name: '큰 제목', sample: '제목',
    font: 'Noto Sans KR', weight: 900, size: 0.11, color: '#ffffff',
    shadow: true, x: 0.5, y: 0.5, anim: 'fade',
  },
  {
    id: 'variety', name: '예능 자막', sample: '대박!',
    font: 'Black Han Sans', weight: 400, size: 0.095, color: '#ffe14d',
    stroke: '#1a1a1a', strokeW: 0.2, x: 0.5, y: 0.78, anim: 'pop', shadow: true,
  },
  {
    id: 'lower', name: '이름표', sample: '홍길동',
    font: 'Noto Sans KR', weight: 700, size: 0.045, color: '#ffffff',
    bg: 'rgba(15,18,30,0.78)', bar: '#4f7cff', align: 'left', x: 0.08, y: 0.8, anim: 'slideUp',
  },
  {
    id: 'highlight', name: '강조 문구', sample: '핵심',
    font: 'Noto Sans KR', weight: 900, size: 0.06, color: '#111111',
    bg: '#ffe14d', x: 0.5, y: 0.2, anim: 'pop',
  },
  {
    id: 'neon', name: '네온', sample: 'NEON',
    font: 'Noto Sans KR', weight: 900, size: 0.08, color: '#e9feff',
    glow: '#22e3ff', x: 0.5, y: 0.5, anim: 'fade',
  },
  {
    id: 'classic', name: '감성 명조', sample: '봄날',
    font: 'Nanum Myeongjo', weight: 800, size: 0.07, color: '#ffffff',
    shadow: true, x: 0.5, y: 0.5, anim: 'fade',
  },
  {
    id: 'minimal', name: '미니멀', sample: 'minimal',
    font: 'Noto Sans KR', weight: 300, size: 0.04, color: '#ffffff',
    shadow: true, x: 0.5, y: 0.9, anim: 'fade', spacing: 0.08,
  },
];
export const textStyleById = (id) => TEXT_STYLES.find((s) => s.id === id) || TEXT_STYLES[0];

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];

export const FONT_LIST = ['Noto Sans KR', 'Black Han Sans', 'Nanum Myeongjo', 'Do Hyeon', 'Nanum Pen Script'];
