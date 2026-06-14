const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()
db.session.findMany()
  .then(sessions => {
    console.log(JSON.stringify(sessions, null, 2))
    return db.$disconnect()
  })
  .catch(e => {
    console.error(e)
    return db.$disconnect()
  })
