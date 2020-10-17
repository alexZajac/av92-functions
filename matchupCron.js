const axios = require("axios");
const cheerio = require("cheerio");
const moment = require("moment");
const { MongoClient } = require('mongodb');
require("dotenv").config({ path: __dirname + "/.env" });
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0;


const getCurrentSeason = () => {
    const currentDate = moment();
    const currentYear = currentDate.month() < 6 ? currentDate.year() - 1 : currentDate.year();
    return `${currentYear}%2F${currentYear+1}`;
}

const encodedSaison = getCurrentSeason();
const teamData = [
    {
        category: "NATIONALE 2 M",
        codent: "ABCCS",
        poule: "2MD",
        numEquipe: 2
    },
    {
        category: "PRENAT F",
        codent: "LIIDF",
        poule: "PFB",
        numEquipe: 6
    },
    {
        category: "REGIONALE M",
        codent: "LIIDF",
        poule: "RMB",
        numEquipe: 9
    },
];

const parseMatchupRow = (row, childrenCount, defaultValue=null) => {
    const currentChild = row.children[childrenCount].children[0];
    return currentChild === undefined ? defaultValue : currentChild.data;
}

const createDate = (date, time) => {
    if(date !== null && time !== null) {
        return moment(`${date} ${time}`, "DD-MM-YY hh:mm").add(2, "hours").toDate();
    }
    if (date === null) return null;
    return moment(date, "DD-MM-YY").add(2, "hours").toDate();
}

const handleRecord = async(record, matchupCollection, teamCollection) => {
    const { matchId, scoreHome, scoreAway, teamHome, teamAway } = record;
    const dbRecord = await matchupCollection.findOne({ matchId });
    // record not present
    if(dbRecord === null){
        await matchupCollection.insertOne(record);
    } 
    else{
        const { logoSrc: srcImageTeamHome } = await teamCollection.findOne({ teamName: teamHome }, { projection: { logoSrc: 1 }}) || {};
        const { logoSrc: srcImageTeamAway } = await teamCollection.findOne({ teamName: teamAway }, { projection: { logoSrc: 1 }}) || {};
        await matchupCollection.updateOne({ matchId }, { $set: { scoreHome, scoreAway, srcImageTeamHome, srcImageTeamAway }});
    }
}

const processMatchup = async(row, teamCollection) => {
    const matchId = parseMatchupRow(row, 0);
    const date = parseMatchupRow(row, 1);
    const time = parseMatchupRow(row, 2);
    // GMT offset
    const matchupDate = createDate(date, time);
    const isNextMatchup = false;
    const teamHome = parseMatchupRow(row, 3);
    const teamAway = parseMatchupRow(row, 5);
    let scoreHome = 0, scoreAway = 0;
    let court = null;
    // matchup already played
    if (row.children[6].name !== 'form') {
        scoreHome = parseInt(parseMatchupRow(row, 6));
        scoreAway = parseInt(parseMatchupRow(row, 7));
    }
    else {
        court = parseMatchupRow(row, 8);
    }
    const { logoSrc: srcImageTeamHome } = await teamCollection.findOne({ teamName: teamHome }, { projection: { logoSrc: 1 }}) || {};
    const { logoSrc: srcImageTeamAway } = await teamCollection.findOne({ teamName: teamAway }, { projection: { logoSrc: 1 }}) || {};
    return {
        matchId: `${matchId}#${date}`, 
        matchupDate,
        isNextMatchup,
        teamHome, 
        teamAway, 
        scoreHome, 
        scoreAway, 
        court, 
        srcImageTeamAway, 
        srcImageTeamHome 
    }
}

const refreshTeamData = async({ numEquipe, codent, poule, category } , db) => {
  const matchupCollection = db.collection("matchups");
  const teamCollection = db.collection("teams");
  const requestUrl = `https://www.ffvbbeach.org/ffvbapp/resu/vbspo_calendrier.php?saison=${encodedSaison}&codent=${codent}&poule=${poule}&calend=COMPLET&equipe=${numEquipe}`;
  // parse page
  const { data: pageData } = await axios.get(requestUrl);
  const $ = cheerio.load(pageData);
  // get valid children
  const childrenRows = [];
  $("body > table:nth-child(6) > tbody > tr").each((i, row) => {
      if(i % 2 === 1) childrenRows.push(row);
  });
  // get a structured data representation
  const processedRecords = await Promise.all(childrenRows.map(async row => await processMatchup(row, teamCollection)));
  // get closest matchup
  const todayDate = Date.now();
  let closestMatchup = null;
  let closestNextDate = Number.MAX_SAFE_INTEGER;
  // insert/update records
  for(const record of processedRecords){
      const { matchupDate } = record;
      const timeDifference = Math.abs(matchupDate - todayDate);
      if(timeDifference < closestNextDate){
          closestNextDate = timeDifference;
          closestMatchup = record;
      }
      await handleRecord({ category, ...record }, matchupCollection, teamCollection);
  }
  // update closest matchup records
  if(closestMatchup !== null){
    const { matchId } = closestMatchup;
    await matchupCollection.updateOne({ matchId }, { $set: { isNextMatchup: true }});
  }
}

(async () => {
    const connectUri = process.env.MONGODB_CONNECTION_URI;
    const client = new MongoClient(connectUri, { useUnifiedTopology: true });
    try {
        await client.connect();
        const db = client.db("AV92");
        // await db.collection("matchups").deleteMany();
        for(const teamEntry of teamData){
            await refreshTeamData(teamEntry, db);
        }
      }
    catch (e) {
        console.log(e)
    }
    finally {
        await client.close();
    }
})();
