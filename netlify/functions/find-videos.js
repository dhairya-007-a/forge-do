// Netlify serverless function — keeps both the Groq and YouTube keys server-side.
// The frontend calls POST /.netlify/functions/find-videos with { subject, chapter }
// and never sees either key. Groq picks a good search phrase for the chapter (chapter
// names like "Trees & Binary Search Trees" don't always make good raw search queries),
// then YouTube search.list finds 5 candidates, then videos.list pulls view counts so
// "best" can mean highest-viewed rather than just YouTube's default relevance order.

const { callGroq } = require('./_groq-client');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ytKey = process.env.YOUTUBE_API_KEY;
  if(!ytKey){
    return { statusCode: 500, body: JSON.stringify({ videos: [], bestVideoId: null, error: 'YOUTUBE_API_KEY not configured on the server' }) };
  }

  let subject, chapter;
  try{
    const body = JSON.parse(event.body || '{}');
    subject = (body.subject || '').trim();
    chapter = (body.chapter || '').trim();
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  if(!subject || !chapter){
    return { statusCode: 400, body: JSON.stringify({ error: 'subject and chapter are required' }) };
  }

  // Default query is a safe fallback if the Groq call below fails for any reason —
  // the feature should still work, just with a slightly worse search phrase.
  let query = `${chapter} ${subject} explained`;
  let groqUsage = null;
  try{
    const { ok, data: phraseData } = await callGroq({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 30,
      messages: [
        { role: 'system', content: 'You write short, effective YouTube search queries for B.Tech Computer Engineering study topics. Respond with ONLY the search query text, nothing else — no quotes, no punctuation, no explanation.' },
        { role: 'user', content: `Topic: "${chapter}" from the subject "${subject}". Write one good YouTube search query for a student who wants to learn this from scratch.` }
      ]
    });
    if(ok){
      if(phraseData.usage){ console.log('[find-videos] groq tokens:', phraseData.usage); groqUsage = phraseData.usage; }
      const text = phraseData.choices && phraseData.choices[0] && phraseData.choices[0].message && phraseData.choices[0].message.content;
      if(text && text.trim()) query = text.trim();
    }
  } catch(e){ /* keep the fallback query built above */ }

  // relevanceLanguage biases YouTube's ranking toward English results — a hint, not a hard
  // filter (YouTube's search API has no hard language filter). The hard filter below excludes
  // Tamil/Kannada results the student doesn't want, via two signals: the declared metadata
  // language (defaultAudioLanguage/defaultLanguage — often unset, so not relied on alone) AND
  // the title/channel text itself (Unicode script range + the language name spelled out) —
  // channels rarely set the metadata field but almost always say "in Tamil" or use Tamil/Kannada
  // script in the title or channel name.
  const BLOCKED_LANGS = ['ta', 'kn'];
  const BLOCKED_SCRIPT = /[஀-௿ಀ-೿]/; // Tamil, Kannada Unicode blocks
  const BLOCKED_WORDS = /\b(tamil|kannada)\b/i;
  const looksBlocked = text => BLOCKED_SCRIPT.test(text) || BLOCKED_WORDS.test(text);
  try{
    const searchResp = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&relevanceLanguage=en&q=${encodeURIComponent(query)}&key=${ytKey}`);
    const searchData = await searchResp.json();
    if(!searchResp.ok){
      const message = (searchData && searchData.error && searchData.error.message) || 'YouTube API error';
      return { statusCode: searchResp.status, body: JSON.stringify({ videos: [], bestVideoId: null, error: message }) };
    }
    let items = Array.isArray(searchData.items) ? searchData.items : [];
    if(!items.length){
      return { statusCode: 200, body: JSON.stringify({ videos: [], bestVideoId: null, error: null, usage: groqUsage }) };
    }

    const ids = items.map(it => it.id.videoId).join(',');
    const statsResp = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids}&key=${ytKey}`);
    const statsData = await statsResp.json();
    const statsById = {};
    (statsData.items || []).forEach(v => { statsById[v.id] = v; });

    items = items.filter(it => {
      const stats = statsById[it.id.videoId];
      const lang = stats && stats.snippet && (stats.snippet.defaultAudioLanguage || stats.snippet.defaultLanguage);
      if(lang && BLOCKED_LANGS.some(blocked => lang.toLowerCase().startsWith(blocked))) return false;
      if(looksBlocked(it.snippet.title) || looksBlocked(it.snippet.channelTitle)) return false;
      return true;
    }).slice(0, 5);

    if(!items.length){
      return { statusCode: 200, body: JSON.stringify({ videos: [], bestVideoId: null, error: null, usage: groqUsage }) };
    }

    const videos = items.map(it => ({
      videoId: it.id.videoId,
      title: it.snippet.title,
      channelTitle: it.snippet.channelTitle,
      thumbnail: it.snippet.thumbnails.medium ? it.snippet.thumbnails.medium.url : it.snippet.thumbnails.default.url,
      viewCount: parseInt(((statsById[it.id.videoId] || {}).statistics || {}).viewCount, 10) || 0
    }));
    const bestVideoId = videos.reduce((best, v) => v.viewCount > best.viewCount ? v : best, videos[0]).videoId;

    return { statusCode: 200, body: JSON.stringify({ videos, bestVideoId, error: null, usage: groqUsage }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ videos: [], bestVideoId: null, error: 'Failed to reach YouTube API: ' + e.message }) };
  }
};
