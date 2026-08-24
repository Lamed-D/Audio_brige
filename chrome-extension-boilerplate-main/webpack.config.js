const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

const config = {
  entry: {
    background: './src/background/index.ts',
    content: './src/content/index.ts',
    offscreen: './src/offscreen/index.ts',
    sidepanel: './src/sidepanel/index.ts',
  },
  output: {
    path: path.resolve(__dirname, 'extension'),
    filename: '[name].js',
    clean: false,
  },
  devtool: 'source-map',
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  optimization: {
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          output: { ascii_only: true },
        },
      }),
    ],
  },
};

module.exports = config;
