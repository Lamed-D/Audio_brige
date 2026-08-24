const path = require('path');

module.exports = {
  context: __dirname,
  mode: 'development',
  target: 'node',
  entry: './src/test.ts',
  output: {
    path: path.join(__dirname, '.codex-test-build'),
    filename: 'tests.cjs',
    clean: true,
  },
  devtool: false,
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: { configFile: path.join(__dirname, 'tsconfig.json') },
        },
        exclude: /node_modules/,
      },
    ],
  },
};
