/* eslint-env node */

import * as webpack from 'webpack'
import * as path from 'path'
import CopyPlugin from 'copy-webpack-plugin'
import TerserPlugin from 'terser-webpack-plugin'

const srcDir = './src/'

const config: webpack.Configuration = {
  mode: 'production',
  entry: {
    background: path.join(__dirname, srcDir + 'background.ts'),
    content: path.join(__dirname, srcDir + 'content.ts'),
  },
  output: {
    path: path.join(__dirname, 'dist/'),
    filename: '[name].js',
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
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
  },
  plugins: [new CopyPlugin([{ from: '.', to: '../dist' }], { context: 'public' })],
}

module.exports = config
