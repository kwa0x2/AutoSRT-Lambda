import AWS from "aws-sdk";
import axios from "axios";
import FormData from "form-data";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import util from "util";

const CONFIG = {
  // AWS Config
  AWS_REGION: AWS_REGION,
  BUCKET_NAME: BUCKET_NAME,
  MAX_RETRIES: 3,
  TIMEOUT: 300000, // 5 min
  CONNECT_TIMEOUT: 5000,

  // OpenAI Config
  OPENAI_API_URL: "https://api.openai.com/v1/audio/transcriptions",
  OPENAI_API_KEY: API_KEY,
  WHISPER_MODEL: "whisper-1",

  // FFMPEG Config
  FFMPEG_PATH: "/opt/bin/ffmpeg",
  FFMPEG_SAMPLE_RATE: 16000,
  FFMPEG_CHANNELS: 1,
  FFMPEG_VOLUME: 1.5,
  FFMPEG_HIGHPASS: 200,
  FFMPEG_LOWPASS: 3000,
  FFMPEG_NOISE_FILTER: -25,

  // File Paths
  VIDEOS_PATH: "videos",
  SRT_FILES_PATH: "srt-files",
  TMP_DIR: "/tmp/",

  // Chunk Config
  CHUNK_SIZE: 1 * 1024 * 1024, // 2MB
};

const s3Client = new AWS.S3({
  region: CONFIG.AWS_REGION,
  maxRetries: CONFIG.MAX_RETRIES,
  httpOptions: {
    timeout: CONFIG.TIMEOUT,
    connectTimeout: CONFIG.CONNECT_TIMEOUT,
  },
});

const apiClient = axios.create({
  baseURL: CONFIG.OPENAI_API_URL,
  headers: {
    Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
  },
  timeout: CONFIG.TIMEOUT,
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});

const convertMp4ToMp3 = async (mp4FilePath, mp3FilePath) => {
  const command = `${CONFIG.FFMPEG_PATH} -i ${mp4FilePath} \
    -vn \
    -acodec libmp3lame \
    -ar ${CONFIG.FFMPEG_SAMPLE_RATE} \
    -ac ${CONFIG.FFMPEG_CHANNELS} \
    -af "volume=${CONFIG.FFMPEG_VOLUME},highpass=f=${CONFIG.FFMPEG_HIGHPASS},lowpass=f=${CONFIG.FFMPEG_LOWPASS},afftdn=nf=${CONFIG.FFMPEG_NOISE_FILTER}" \
    -q:a 0 \
    -map_metadata -1 \
    -id3v2_version 0 \
    ${mp3FilePath}`;

  const execPromise = util.promisify(exec);

  try {
    await execPromise(command);
  } catch (error) {
    throw new Error(`FFmpeg error: ${error.message}`);
  }
};

const processInChunks = async (audioFile, chunkSize = CONFIG.CHUNK_SIZE) => {
  const chunks = [];
  for (let i = 0; i < audioFile.length; i += chunkSize) {
    chunks.push(audioFile.slice(i, i + chunkSize));
  }

  const promises = chunks.map(async (chunk, index) => {
    const form = new FormData();
    form.append("file", chunk, `chunk_${index}.mp3`);
    form.append("model", CONFIG.WHISPER_MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");

    return apiClient.post("", form, {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${form.getBoundary()}`,
      },
    });
  });

  return Promise.all(promises);
};

class SrtGenerator {
  static formatTime(time) {
    const seconds = Math.floor(time);
    const milliseconds = Math.round((time - seconds) * 1000);
    const minutes = Math.floor(seconds / 60);
    const formattedSeconds = seconds % 60;
    return `${this.pad(minutes)}:${this.pad(formattedSeconds)}.${this.pad(milliseconds, 3)}`;
  }

  static pad(num, length = 2) {
    return num.toString().padStart(length, "0");
  }

  static findWordMatches(textWords, apiWords) {
    const matches = [];
    let currentTextIndex = 0;
    let currentApiIndex = 0;
    let currentGroup = [];

    while (currentTextIndex < textWords.length && currentApiIndex < apiWords.length) {
      const textWord = textWords[currentTextIndex];
      const apiWord = apiWords[currentApiIndex].word;

      if (textWord.includes(apiWord)) {
        currentGroup.push(apiWords[currentApiIndex]);

        const combinedApiWords = currentGroup
          .map((w) => w.word)
          .join("");

        if (textWord === combinedApiWords) {
          matches.push({
            textWord: textWords[currentTextIndex],
            apiWords: currentGroup,
            startTime: currentGroup[0].start,
            endTime: currentGroup[currentGroup.length - 1].end,
          });
          currentGroup = [];
          currentTextIndex++;
        }
        currentApiIndex++;
      } else {
        if (currentGroup.length > 0) {
          matches.push({
            textWord: textWords[currentTextIndex],
            apiWords: currentGroup,
            startTime: currentGroup[0].start,
            endTime: currentGroup[currentGroup.length - 1].end,
          });
        }
        currentGroup = [];
        currentTextIndex++;
      }
    }

    return matches;
  }

  static generate(verboseJson, wordsPerLine, punctuation = false, considerPunctuation = true) {
    if (!verboseJson?.text || !verboseJson?.words) {
      throw new Error("Invalid verbose JSON format");
    }

    const textWords = verboseJson.text.trim().split(" ");
    let entries = [];

    if (punctuation) {
      const wordMatches = this.findWordMatches(textWords, verboseJson.words);
      entries = wordMatches.map(match => ({
        text: match.textWord,
        startTime: match.startTime,
        endTime: match.endTime
      }));
    } else {
      entries = verboseJson.words.map(word => ({
        text: word.word,
        startTime: word.start,
        endTime: word.end
      }));
    }

    const srtEntries = [];
    let currentEntry = {
      counter: 1,
      startTime: 0,
      words: [],
    };

    let duration = 0;

    entries.forEach((entry, i) => {
      if (currentEntry.words.length === 0) {
        currentEntry.startTime = entry.startTime;
      }

      currentEntry.words.push(entry.text);
      duration = Math.max(duration, entry.endTime);

      const isLastWord = i === entries.length - 1;
      const hasEndPunctuation = considerPunctuation ? entry.text.match(/[.!?]$/) : false;
      const reachedWordLimit = currentEntry.words.length === wordsPerLine;

      if (isLastWord || hasEndPunctuation || reachedWordLimit) {
        srtEntries.push({
          counter: currentEntry.counter,
          startTime: currentEntry.startTime,
          endTime: entry.endTime,
          text: currentEntry.words.join(" "),
        });

        currentEntry = {
          counter: currentEntry.counter + 1,
          startTime: 0,
          words: [],
        };
      }
    });

    return {
      content: srtEntries
        .map((entry) => `${entry.counter}\n${this.formatTime(entry.startTime)} --> ${this.formatTime(entry.endTime)}\n${entry.text}\n\n`)
        .join(""),
      duration: parseFloat(duration.toFixed(2)),
    };
  }
}

export const handler = async (event) => {
  try {
    console.time("total-execution");
    const { file_name, user_id, words_per_line, punctuation, consider_punctuation } = event;

    if (!file_name || !user_id || !words_per_line || 
        typeof punctuation !== 'boolean' || 
        typeof consider_punctuation !== 'boolean') {
      return {
        status_code: 400,
        body: {
          message: "Missing required parameters. Please try again later or contact support.",
          srt_url: "",
          duration: 0,
        },
      };
    }

    if (!punctuation && consider_punctuation) {
    return {
      status_code: 400,
      body: {
        message: "Consider Punctuation cannot be true when punctuation is false",
        srt_url: "",
        duration: 0,
      },
    };
  }

    const mp4FilePath = path.join(CONFIG.TMP_DIR, file_name);
    const mp3FilePath = path.join(CONFIG.TMP_DIR, file_name.replace(".mp4", ".mp3"));

    console.time("s3-fetch");
    const audioFile = await s3Client
      .getObject({
        Bucket: CONFIG.BUCKET_NAME,
        Key: `${CONFIG.VIDEOS_PATH}/${user_id}/${file_name}`,
      })
      .promise()
      .then((data) => data.Body);
    fs.writeFileSync(mp4FilePath, audioFile);
    console.timeEnd("s3-fetch");

    console.time("ffmpeg-conversion");
    await convertMp4ToMp3(mp4FilePath, mp3FilePath);
    console.timeEnd("ffmpeg-conversion");

    console.time("whisper-api");
    const audioFileBuffer = fs.readFileSync(mp3FilePath);
    const chunkResponses = await processInChunks(audioFileBuffer);
    console.timeEnd("whisper-api");

    console.time("srt-generation");
    const combinedTranscription = {
      text: chunkResponses.map((res) => res.data.text).join(" "),
      words: chunkResponses.flatMap((res) => res.data.words),
    };

    const srtResult = SrtGenerator.generate(combinedTranscription, words_per_line, punctuation, consider_punctuation);
    console.timeEnd("srt-generation");

    console.time("s3-upload");
    const srtFileKey = `${CONFIG.SRT_FILES_PATH}/${user_id}/${file_name.replace(".mp4", ".srt")}`;
    await s3Client
      .putObject({
        Bucket: CONFIG.BUCKET_NAME,
        Key: srtFileKey,
        Body: srtResult.content,
        ContentType: "application/x-subrip",
      })
      .promise();
    console.timeEnd("s3-upload");

    const s3Url = `https://${CONFIG.BUCKET_NAME}.s3.amazonaws.com/${srtFileKey}`;

    console.timeEnd("total-execution");

    return {
      status_code: 200,
      body: {
        message: "success",
        srt_url: s3Url,
        duration: srtResult.duration,
      },
    };
  } catch (error) {
    return {
      status_code: error.response?.status || 500,
      body: {
        message: "An error occurred. Please try again later or contact support.",
        srt_url: "",
        duration: 0,
      },
    };
  }
}; 