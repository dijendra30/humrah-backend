const { generatePostPreview } = require('./utils/SharePreviewGenerator');
const post = {
    _id: '6a5f28b2a6e5459bcce85c4b',
    userId: { firstName: 'Rahul', lastName: 'Saini' },
    caption: 'I love Nature??',
    imageUrl: 'https://res.cloudinary.com/dipycpjoy/image/upload/w_1200,h_630,c_fill/v1784621233/humrah/posts/d2lim5g0hqb7m12ubwtw.jpg'
};
console.log(generatePostPreview(post));
