/**
 * 应用配置文件
 *
 * 修改此文件可自定义品牌信息，无需修改代码
 * 图片文件放在 public/images/ 目录下
 */

export default {
  // 品牌名称（店铺名）
  brandName: 'M.77美肤空间',

  // 行业类型（修改此项会自动切换对应背景图）
  industryType: '美业',

  // 系统名称
  systemName: '店务管理系统',

  // 原品牌英文展示字样
  englishName: 'PERSONAL TAILOR',

  // 完整标题（用于浏览器标签页）
  get fullTitle() {
    return `${this.brandName} · 青丝${this.systemName}`;
  },

  // 登录页宣传语
  slogan: '专做别人做不好·被伤过的皮肤',

  // 平台署名
  platformName: '青丝',

  // 资源文件路径（相对于 public 目录）
  logo: '/images/m77-brand-reference.png',

  // 登录页背景图（根据行业类型自动选择，也可手动指定）
  brandReference: '/images/m77-brand-reference.png',
};
