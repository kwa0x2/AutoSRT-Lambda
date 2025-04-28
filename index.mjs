import AWS from "aws-sdk";
import axios from "axios";
import FormData from "form-data";
import path from "path";

const CONFIG = {
  // AWS Config
  AWS_REGION: AWS_REGION,
  BUCKET_NAME: BUCKET_NAME,
  MAX_RETRIES: 3,
  TIMEOUT: 300000, // 5 min
  CONNECT_TIMEOUT: 5000,

  // OpenAI Config
  OPENAI_API_URL: "https://api.openai.com/v1/audio/transcriptions",
  OPENAI_API_KEY: OPENAI_API_KEY,
  WHISPER_MODEL: "whisper-1",

  // File Paths
  FILES_PATH: "files",
  SRT_FILES_PATH: "srt-files",
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

const processFile = async (file, fileExtension) => {
  const form = new FormData();

  const contentTypeMap = {
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
  };

  form.append("file", Buffer.from(file), {
    filename: `video${fileExtension}`,
    contentType: contentTypeMap[fileExtension] || "application/octet-stream",
  });

  form.append("model", CONFIG.WHISPER_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  form.append("prompt", "Bu bir video transkripsiyonudur.");

  const response = await apiClient.post("", form, {
    headers: form.getHeaders(),
  });
  return [response];
};

class SrtGenerator {
  static formatTime(time) {
    const seconds = Math.floor(time);
    const milliseconds = Math.round((time - seconds) * 1000);
    const minutes = Math.floor(seconds / 60);
    const formattedSeconds = seconds % 60;
    return `${this.pad(minutes)}:${this.pad(formattedSeconds)}.${this.pad(
      milliseconds,
      3
    )}`;
  }

  static pad(num, length = 2) {
    return num.toString().padStart(length, "0");
  }

  static findWordMatches(textWords, apiWords) {
    const matches = [];
    let currentTextIndex = 0;
    let currentApiIndex = 0;
    let currentGroup = [];

    while (
      currentTextIndex < textWords.length &&
      currentApiIndex < apiWords.length
    ) {
      const textWord = textWords[currentTextIndex];
      const apiWord = apiWords[currentApiIndex].word;

      if (textWord.includes(apiWord)) {
        currentGroup.push(apiWords[currentApiIndex]);

        const combinedApiWords = currentGroup.map((w) => w.word).join("");

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

  static generate(
    verboseJson,
    wordsPerLine,
    punctuation = false,
    considerPunctuation = true
  ) {
    if (!verboseJson?.text || !verboseJson?.words) {
      throw new Error("Invalid verbose JSON format");
    }

    const textWords = verboseJson.text.trim().split(" ");
    let entries = [];

    if (punctuation) {
      const wordMatches = this.findWordMatches(textWords, verboseJson.words);
      entries = wordMatches.map((match) => ({
        text: match.textWord,
        startTime: match.startTime,
        endTime: match.endTime,
      }));
    } else {
      entries = verboseJson.words.map((word) => ({
        text: word.word,
        startTime: word.start,
        endTime: word.end,
      }));
    }

    const srtEntries = [];
    let currentEntry = {
      counter: 1,
      startTime: 0,
      words: [],
    };


    entries.forEach((entry, i) => {
      if (currentEntry.words.length === 0) {
        currentEntry.startTime = entry.startTime;
      }

      currentEntry.words.push(entry.text);

      const isLastWord = i === entries.length - 1;
      const hasEndPunctuation = considerPunctuation
        ? entry.text.match(/[.!?]$/)
        : false;
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
        .map(
          (entry) =>
            `${entry.counter}\n${this.formatTime(
              entry.startTime
            )} --> ${this.formatTime(entry.endTime)}\n${entry.text}\n\n`
        )
        .join(""),
    };
  }
}

export const handler = async (event) => {
  try {
    console.time("total-execution");
    const {
      file_name,
      user_id,
      words_per_line,
      punctuation,
      consider_punctuation,
    } = event;

    if (
      !file_name ||
      !user_id ||
      !words_per_line ||
      typeof punctuation !== "boolean" ||
      typeof consider_punctuation !== "boolean" 
    ) {
      return {
        status_code: 400,
        body: {
          message:
            "Missing required parameters. Please try again later or contact support.",
          srt_url: "",
        },
      };
    }

    if (words_per_line < 0 || words_per_line > 5) {
      return {
        status_code: 400,
        body: {
          message: "words_per_line must be between 1 and 5.",
          srt_url: "",
        },
      };
    }

    const fileExtension = path.extname(file_name).toLowerCase();
    const allowedExtensions = [".mp4", ".mp3", ".wav"];

    if (!allowedExtensions.includes(fileExtension)) {
      return {
        status_code: 400,
        body: {
          message: `Invalid file type. Only ${allowedExtensions.join(
            ", "
          )} files are allowed.`,
          srt_url: "",
        },
      };
    }

    if (!punctuation && consider_punctuation) {
      return {
        status_code: 400,
        body: {
          message:
            "Consider Punctuation cannot be true when punctuation is false",
          srt_url: "",
        },
      };
    }

    const fileKey = `${CONFIG.FILES_PATH}/${user_id}/${file_name}`;
    const srtFileKey = `${CONFIG.SRT_FILES_PATH}/${user_id}/${file_name.replace(
      /\.(mp4|mp3|wav)$/i,
      ".srt"
    )}`;

    console.time("s3-fetch");
    const file = await s3Client
      .getObject({
        Bucket: CONFIG.BUCKET_NAME,
        Key: fileKey,
      })
      .promise()
      .then((data) => data.Body);
    console.timeEnd("s3-fetch");

    console.time("whisper-api");
    const chunkResponses = await processFile(file, fileExtension);
    console.timeEnd("whisper-api");

    console.time("srt-generation");
    const combinedTranscription = {
      text: chunkResponses.map((res) => res.data.text).join(" "),
      words: chunkResponses.flatMap((res) => res.data.words),
    };

    const srtResult = SrtGenerator.generate(
      combinedTranscription,
      words_per_line,
      punctuation,
      consider_punctuation
    );
    console.timeEnd("srt-generation");

    console.time("s3-upload");
    const uploadResult = await s3Client
      .upload({
        Bucket: CONFIG.BUCKET_NAME,
        Key: srtFileKey,
        Body: srtResult.content,
        ContentType: "application/x-subrip",
      })
      .promise();

    const s3Url = uploadResult.Location;
    console.timeEnd("s3-upload");

    console.timeEnd("total-execution");

    return {
      status_code: 200,
      body: {
        message: "SRT file generated successfully!",
        srt_url: s3Url,
      },
    };
  } catch (error) {
    return {
      status_code: error.response?.status || 500,
      body: {
        message: error.response?.data?.error?.message || error.message || "An error occurred while processing your request.",
        srt_url: "",
      },
    };
  }
};
