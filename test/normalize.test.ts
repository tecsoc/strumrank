import { describe, expect, it } from 'vitest'
import { isExcludedRecording, normalizeArtist, normalizeTitle } from '../src/shared/normalize'

// 実際に iTunes / Deezer から返ってきた表記ゆれ。同じ曲は同じキーになること。
describe('normalizeTitle: 録音違いを同じ曲にまとめる', () => {
  it.each([
    ['マリーゴールド', 'マリーゴールド'],
    ['マリーゴールド (Live in 阪神甲子園球場, 2022.11.05)', 'マリーゴールド'],
    ['高嶺の花子さん (Live at NISSAN STADIUM, 2026)', '高嶺の花子さん'],
    ['115万キロのフィルム (LIVE)', '115万キロのフィルム'],
    ['Pretender (OFFICIAL HIGE DANDISM LIVE at STADIUM 2025)', 'pretender'],
    ['天体観測 (2022 Rerecording Version)', '天体観測'],
    ['ひまわりの約束 (evergreen ver.)', 'ひまわりの約束'],
    ['はいよろこんで - From THE FIRST TAKE', 'はいよろこんで'],
    ['Lemon - Remastered 2024', 'lemon'],
    ['夜に駆ける (feat. ikura)', '夜に駆ける'],
    ['Mela!', 'mela!'],
    ['Ｍｅｌａ！', 'mela!'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected)
  })
})

describe('normalizeTitle: 曲名の一部であるカッコ書きは残す', () => {
  it.each([
    ['さくら(独唱)', 'さくら(独唱)'],
    ['さくら（独唱）', 'さくら(独唱)'],
    ['蕾(つぼみ)', '蕾(つぼみ)'],
    ['なんでもないよ、', 'なんでもないよ、'],
    ['First Love', 'firstlove'],
    // サブタイトルの from / take は版の違いではない
    ['Stay (Take Me Home)', 'stay(takemehome)'],
    ['Hero - Take Me Away', 'hero-takemeaway'],
    ['Dreams (From the Heart)', 'dreams(fromtheheart)'],
    ['Mix Juice', 'mixjuice'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected)
  })
})

describe('normalizeTitle: 付記全体が既知の形なら除去する', () => {
  it.each([
    ['Stay (Radio Edit)', 'stay'],
    ['Stay - Single Edit', 'stay'],
    ['Stay (From 「映画」)', 'stay'],
    ['Stay (2019 Mix)', 'stay'],
    ['Stay (Remix)', 'stay'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected)
  })
})

describe('normalizeArtist', () => {
  it.each([
    ['藤井 風', '藤井風'],
    ['藤井風', '藤井風'],
    ['back number', 'backnumber'],
    ['Back Number', 'backnumber'],
    ['Mrs. GREEN APPLE', 'mrs.greenapple'],
    // 名前の先頭の feat/ft は除去しない（空文字にしない）
    ['FT Island', 'ftisland'],
    ['Ft. Island', 'ft.island'],
    ['feat', 'feat'],
    ['YOASOBI feat. ikura', 'yoasobi'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeArtist(input)).toBe(expected)
  })
})

describe('isExcludedRecording: ボーカルなし・カラオケは候補から外す', () => {
  it.each([
    ['マリーゴールド (Instrumental)', true],
    ['水平線-1Key(原曲歌手:back number)[ガイド無しカラオケ]', true],
    ['Lemon (Off Vocal)', true],
    ['Lemon (Karaoke Version)', true],
    ['マリーゴールド', false],
    ['マリーゴールド (Live in 阪神甲子園球場, 2022.11.05)', false],
  ])('%s → %s', (input, expected) => {
    expect(isExcludedRecording(input)).toBe(expected)
  })
})
