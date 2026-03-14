// App.js  — всё локально, цель < 1 сек скриншот→уведомление
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, Switch, ScrollView, AppState } from 'react-native';
import * as MediaLibrary   from 'expo-media-library';
import * as Notifications  from 'expo-notifications';
import * as FileSystem     from 'expo-file-system';
import { Audio }           from 'expo-av';
import MlkitOcr            from 'react-native-mlkit-ocr';
import { loadQuestions, findBestMatch } from './pddSearch';

// ─── Инициализируем базу при старте (фоново) ──────────────
loadQuestions();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,   // тихо, чтобы не спалили
    shouldSetBadge:  false,
  }),
});

export default function App() {
  const [active, setActive]       = useState(false);
  const [status, setStatus]       = useState('Выключен');
  const [lastAnswer, setLastAnswer] = useState(null);
  const [timingMs, setTimingMs]   = useState(null);

  const soundRef      = useRef(null);
  const subRef        = useRef(null);
  const lastIdRef     = useRef(null);
  const processingRef = useRef(false);
  const appStateRef   = useRef(AppState.currentState);

  useEffect(() => {
    setup();
    const sub = AppState.addEventListener('change', onAppState);
    return () => { cleanup(); sub.remove(); };
  }, []);

  const setup = async () => {
    await MediaLibrary.requestPermissionsAsync();
    const { status } = await Notifications.requestPermissionsAsync();
    console.log('Notifications:', status);
  };

  // ─── Тихое аудио ─────────────────────────────────────────
  const startSilentAudio = async () => {
    await Audio.setAudioModeAsync({
      staysActiveInBackground: true,
      playsInSilentModeIOS:    true,
      allowsRecordingIOS:      false,
    });
    // Минимальный валидный WAV (44 байта заголовок + 1 сэмпл тишины)
    const silentWav =
      'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    const { sound } = await Audio.Sound.createAsync(
      { uri: `data:audio/wav;base64,${silentWav}` },
      { isLooping: true, volume: 0.01 }
    );
    soundRef.current = sound;
    await sound.playAsync();
  };

  const stopSilentAudio = async () => {
    if (!soundRef.current) return;
    await soundRef.current.stopAsync();
    await soundRef.current.unloadAsync();
    soundRef.current = null;
  };

  // ─── AppState: если вернулись в foreground — сбрасываем флаг ──
  const onAppState = (next) => {
    appStateRef.current = next;
    if (next === 'active') processingRef.current = false;
  };

  // ─── Toggle ───────────────────────────────────────────────
  const toggle = useCallback(async (val) => {
    setActive(val);
    if (val) {
      setStatus('🟢 Жду скриншот...');
      await startSilentAudio();
      subRef.current = MediaLibrary.addListener(onLibraryChange);
    } else {
      setStatus('⚪ Выключен');
      await stopSilentAudio();
      subRef.current?.remove();
    }
  }, []);

  // ─── Слушатель галереи ────────────────────────────────────
  const onLibraryChange = useCallback(async () => {
    if (processingRef.current) return;

    const { assets } = await MediaLibrary.getAssetsAsync({
      first: 1,
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      mediaType: MediaLibrary.MediaType.photo,
    });
    if (!assets.length) return;

    const asset = assets[0];
    if (asset.id === lastIdRef.current) return;

    // Только свежие фото (последние 10 сек)
    const ageMs = Date.now() - asset.creationTime * 1000;
    if (ageMs > 10_000) return;

    lastIdRef.current     = asset.id;
    processingRef.current = true;
    await processScreenshot(asset);
    processingRef.current = false;
  }, []);

  // ─── Главная обработка ────────────────────────────────────
  const processScreenshot = async (asset) => {
    const t0 = Date.now();
    setStatus('📸 Читаю...');

    try {
      // 1. Получаем путь к файлу
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      const uri  = info.localUri || info.uri;

      // 2. ML Kit OCR — на устройстве, без сети (~150-300мс)
      const blocks  = await MlkitOcr.detectFromUri(uri);
      const ocrText = blocks.map(b => b.text).join(' ');

      if (!ocrText.trim()) {
        setStatus('🟡 Текст не найден');
        return;
      }

      // 3. Поиск по индексу (~1-5мс)
      const { result, score } = findBestMatch(ocrText);
      const elapsed = Date.now() - t0;
      setTimingMs(elapsed);

      if (result) {
        const correct  = result.варианты?.find(v => v.правильный)?.текст || result.ответ || '—';
        const allLines = result.варианты
          ?.map(v => `${v.правильный ? '✅' : '❌'} ${v.текст}`)
          .join('\n') ?? correct;

        // 4. Уведомление
        await Notifications.scheduleNotificationAsync({
          content: {
            title: `✅  ${correct}`,
            body:  result.вопрос?.slice(0, 100) ?? '',
          },
          trigger: null,
        });

        setLastAnswer({ question: result.вопрос, answer: correct, score, all: allLines });
        setStatus(`✅ Готово за ${elapsed} мс`);
      } else {
        setStatus(`😕 Не найдено (${elapsed} мс)`);
        await Notifications.scheduleNotificationAsync({
          content: { title: '😕 Не найдено', body: ocrText.slice(0, 80) },
          trigger: null,
        });
      }
    } catch (e) {
      console.error(e);
      setStatus(`⚠️ ${e.message}`);
    }
  };

  const cleanup = () => {
    stopSilentAudio();
    subRef.current?.remove();
  };

  // ─── UI ──────────────────────────────────────────────────
  return (
    <ScrollView contentContainerStyle={s.container}>
      <Text style={s.title}>🚗 ПДД</Text>

      <View style={s.card}>
        <View style={s.row}>
          <Text style={s.label}>{active ? 'Активен' : 'Выключен'}</Text>
          <Switch value={active} onValueChange={toggle}
            trackColor={{ false: '#333', true: '#4CAF50' }}
            thumbColor="#fff" />
        </View>
        <Text style={s.status}>{status}</Text>
        {timingMs && <Text style={s.timing}>⚡ Последний: {timingMs} мс</Text>}
        <Text style={s.hint}>Включи → сверни → делай скриншот в приложении ПДД</Text>
      </View>

      {lastAnswer && (
        <View style={s.answer}>
          <Text style={s.q} numberOfLines={4}>{lastAnswer.question}</Text>
          <Text style={s.correct}>✅ {lastAnswer.answer}</Text>
          <Text style={s.all}>{lastAnswer.all}</Text>
          <Text style={s.score}>Совпадение: {lastAnswer.score}%</Text>
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, backgroundColor: '#111', alignItems: 'center' },
  title:     { fontSize: 28, fontWeight: '800', color: '#fff', marginTop: 64, marginBottom: 20 },
  card:      { backgroundColor: '#1c1c1e', borderRadius: 16, padding: 20, width: '100%', marginBottom: 16 },
  row:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  label:     { color: '#fff', fontSize: 18, fontWeight: '600' },
  status:    { color: '#8e8e93', fontSize: 13 },
  timing:    { color: '#30d158', fontSize: 12, marginTop: 6, fontWeight: '700' },
  hint:      { color: '#48484a', fontSize: 12, marginTop: 10, lineHeight: 17 },
  answer:    { backgroundColor: '#1c1c1e', borderRadius: 16, padding: 20, width: '100%' },
  q:         { color: '#8e8e93', fontSize: 13, marginBottom: 10 },
  correct:   { color: '#30d158', fontSize: 20, fontWeight: '800', marginBottom: 10 },
  all:       { color: '#aeaeb2', fontSize: 13, lineHeight: 22 },
  score:     { color: '#48484a', fontSize: 11, marginTop: 8 },
});