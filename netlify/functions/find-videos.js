// Netlify serverless function — keeps both the Groq and YouTube keys server-side.
// The frontend calls POST /.netlify/functions/find-videos with { subject, chapter }
// and never sees either key. Groq picks a good search phrase for the chapter (chapter
// names like "Trees & Binary Search Trees" don't always make good raw search queries),
// then YouTube search.list finds 5 candidates, then videos.list pulls view counts so
// "best" can mean highest-viewed rather than just YouTube's default relevance order.

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const groqKey = process.env.GROQ_API_KEY;
  const ytKey = process.env.YOUTUBE_API_KEY;
  if(!groqKey || !ytKey){
    return { statusCode: 500, body: JSON.stringify({ videos: [], bestVideoId: null, error: 'API key not configured on the server' }) };
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
  try{
    const phraseResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${groqKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 30,
        messages: [
          { role: 'system', content: 'You write short, effective YouTube search queries for B.Tech Computer Engineering study topics. Respond with ONLY the search query text, nothing else — no quotes, no punctuation, no explanation.' },
          { role: 'user', content: `Topic: "${chapter}" from the subject "${subject}". Write one good YouTube search query for a student who wants to learn this from scratch.` }
        ]
      })
    });
    const phraseData = await phraseResp.json();
    if(phraseData.usage) console.log('[find-videos] groq tokens:', phraseData.usage);
    const text = phraseData.choices && phraseData.choices[0] && phraseData.choices[0].message && phraseData.choices[0].message.content;
    if(text && text.trim()) query = text.trim();
  } catch(e){ /* keep the fallback query built above */ }

  try{
    const searchResp = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(query)}&key=${ytKey}`);
    const searchData = await searchResp.json();
    if(!searchResp.ok){
      const message = (searchData && searchData.error && searchData.error.message) || 'YouTube API error';
      return { statusCode: searchResp.status, body: JSON.stringify({ videos: [], bestVideoId: null, error: message }) };
    }
    const items = Array.isArray(searchData.items) ? searchData.items : [];
    if(!items.length){
      return { statusCode: 200, body: JSON.stringify({ videos: [], bestVideoId: null, error: null }) };
    }

    const ids = items.map(it => it.id.videoId).join(',');
    const statsResp = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${ytKey}`);
    const statsData = await statsResp.json();
    const viewsById = {};
    (statsData.items || []).forEach(v => { viewsById[v.id] = parseInt(v.statistics.viewCount, 10) || 0; });

    const videos = items.map(it => ({
      videoId: it.id.videoId,
      title: it.snippet.title,
      channelTitle: it.snippet.channelTitle,
      thumbnail: it.snippet.thumbnails.medium ? it.snippet.thumbnails.medium.url : it.snippet.thumbnails.default.url,
      viewCount: viewsById[it.id.videoId] || 0
    }));
    const bestVideoId = videos.reduce((best, v) => v.viewCount > best.viewCount ? v : best, videos[0]).videoId;

    return { statusCode: 200, body: JSON.stringify({ videos, bestVideoId, error: null }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ videos: [], bestVideoId: null, error: 'Failed to reach YouTube API: ' + e.message }) };
  }
};
