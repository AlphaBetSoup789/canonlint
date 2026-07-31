const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const wrap = (code: string) => (s: string) => (useColor ? `[${code}m${s}[0m` : s);

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
};

export const log = {
  info(message: string): void {
    console.log(message);
  },
  success(message: string): void {
    console.log(`${style.green('✓')} ${message}`);
  },
  warn(message: string): void {
    console.error(`${style.yellow('!')} ${message}`);
  },
  error(message: string): void {
    console.error(`${style.red('✗')} ${message}`);
  },
  detail(message: string): void {
    console.log(style.dim(`  ${message}`));
  },
};
